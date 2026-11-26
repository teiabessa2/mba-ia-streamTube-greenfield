import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import { InvalidMediaError } from '../media/media.errors';
import { MediaService } from '../media/media.service';
import type { ProbeResult } from '../media/media.types';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { type ProcessVideoJobData, VideoStatus } from '../videos/videos.types';
import { VideoProcessor } from './video.processor';

const VIDEO_ID = '7d1c0f9e-2b5a-4c3d-9e8f-1a2b3c4d5e6f';
const SOURCE_URL = 'http://minio:9000/streamtube/videos/original?sig';
const PROBE: ProbeResult = {
  durationSeconds: 40,
  metadata: {
    width: 1280,
    height: 720,
    videoCodec: 'h264',
    audioCodec: 'aac',
    bitrate: 2_000_000,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 10_000_000,
  },
};

const jobFor = (videoId: string) =>
  ({ id: videoId, data: { videoId } }) as Job<ProcessVideoJobData>;

describe('VideoProcessor.process', () => {
  let processor: VideoProcessor;
  let repo: { findOneBy: jest.Mock; update: jest.Mock };
  let storage: { presignInternalGet: jest.Mock; putObject: jest.Mock };
  let media: { probe: jest.Mock; extractFrame: jest.Mock };
  let framePaths: string[];

  const videoIn = (status: VideoStatus): Partial<Video> => ({
    id: VIDEO_ID,
    status,
    storage_key: `videos/${VIDEO_ID}/original`,
  });

  beforeEach(async () => {
    framePaths = [];
    repo = {
      findOneBy: jest.fn().mockResolvedValue(videoIn(VideoStatus.PROCESSING)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      presignInternalGet: jest.fn().mockResolvedValue(SOURCE_URL),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    media = {
      probe: jest.fn().mockResolvedValue(PROBE),
      // Writes a fake JPEG where the processor asked for it.
      extractFrame: jest.fn(async (_url: string, _at: number, path: string) => {
        framePaths.push(path);
        await writeFile(path, Buffer.from([0xff, 0xd8, 0xff]));
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: MediaService, useValue: media },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessor);
  });

  const expectNoSideEffects = () => {
    expect(storage.presignInternalGet).not.toHaveBeenCalled();
    expect(media.probe).not.toHaveBeenCalled();
    expect(media.extractFrame).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  };

  it('should be a no-op when the video does not exist', async () => {
    repo.findOneBy.mockResolvedValue(null);

    await expect(processor.process(jobFor(VIDEO_ID))).resolves.toBeUndefined();

    expectNoSideEffects();
  });

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'should be a no-op when the video is %s',
    async (status) => {
      repo.findOneBy.mockResolvedValue(videoIn(status));

      await expect(
        processor.process(jobFor(VIDEO_ID)),
      ).resolves.toBeUndefined();

      expectNoSideEffects();
    },
  );

  it('should probe the internal URL, upload the frame taken at 10% and mark the video ready in a single update', async () => {
    await processor.process(jobFor(VIDEO_ID));

    expect(storage.presignInternalGet).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
      900,
    );
    expect(media.probe).toHaveBeenCalledWith(SOURCE_URL);
    expect(media.extractFrame).toHaveBeenCalledWith(
      SOURCE_URL,
      4,
      expect.any(String),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/thumbnail.jpg`,
      Buffer.from([0xff, 0xd8, 0xff]),
      'image/jpeg',
    );
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VideoStatus.PROCESSING },
      {
        duration_seconds: 40,
        metadata: PROBE.metadata,
        thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
        status: VideoStatus.READY,
      },
    );
  });

  it('should remove the temporary JPEG directory after the upload', async () => {
    await processor.process(jobFor(VIDEO_ID));

    await expect(access(dirname(framePaths[0]))).rejects.toThrow();
  });

  it('should throw UnrecoverableError when the media is invalid, without extracting a frame or updating', async () => {
    media.probe.mockRejectedValue(new InvalidMediaError('No video stream'));

    const error = await processor
      .process(jobFor(VIDEO_ID))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('No video stream');
    expect(media.extractFrame).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should rethrow a transient probe error as is (retried by the queue)', async () => {
    const transient = new Error('ffprobe timed out after 30000ms');
    media.probe.mockRejectedValue(transient);

    await expect(processor.process(jobFor(VIDEO_ID))).rejects.toBe(transient);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should rethrow a frame extraction failure and still remove the temporary directory', async () => {
    const transient = new Error('ffmpeg failed');
    media.extractFrame.mockImplementation((_url, _at, path: string) => {
      framePaths.push(path);
      return Promise.reject(transient);
    });

    await expect(processor.process(jobFor(VIDEO_ID))).rejects.toBe(transient);

    expect(storage.putObject).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    await expect(access(dirname(framePaths[0]))).rejects.toThrow();
  });
});

describe('VideoProcessor.onFailed', () => {
  let processor: VideoProcessor;
  let repo: { findOneBy: jest.Mock; update: jest.Mock };

  const failedJob = (attemptsMade: number, attempts = 3) =>
    ({
      id: VIDEO_ID,
      data: { videoId: VIDEO_ID },
      attemptsMade,
      opts: { attempts },
    }) as Job<ProcessVideoJobData>;

  const expectMarkedFailed = (reason: string) => {
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
  };

  beforeEach(async () => {
    repo = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: {} },
        { provide: MediaService, useValue: {} },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessor);
  });

  it('should mark the video failed on an UnrecoverableError at the first attempt', async () => {
    await processor.onFailed(
      failedJob(1),
      new UnrecoverableError('No video stream found in the file'),
    );

    expectMarkedFailed('No video stream found in the file');
  });

  it('should leave the video untouched on a plain error with attempts left', async () => {
    await processor.onFailed(failedJob(1), new Error('ffprobe failed: 403'));
    await processor.onFailed(failedJob(2), new Error('ffprobe failed: 403'));

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed on a plain error once attemptsMade reaches attempts', async () => {
    await processor.onFailed(failedJob(3), new Error('ffprobe failed: 403'));

    expectMarkedFailed('ffprobe failed: 403');
  });

  it('should strip the presigned URL echoed by ffprobe from the stored reason', async () => {
    await processor.onFailed(
      failedJob(3),
      new Error(
        'ffprobe failed: http://minio:9000/streamtube/videos/x/original?X-Amz-Signature=abc&X-Amz-Expires=900: Server returned 404 Not Found',
      ),
    );

    expectMarkedFailed(
      'ffprobe failed: <source>: Server returned 404 Not Found',
    );
  });

  it('should ignore a failed event without a job', async () => {
    await processor.onFailed(undefined, new Error('stalled'));

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should log and not throw when the failed status cannot be saved', async () => {
    repo.update.mockRejectedValue(new Error('connection lost'));

    await expect(
      processor.onFailed(failedJob(3), new Error('ffprobe failed')),
    ).resolves.toBeUndefined();
  });
});
