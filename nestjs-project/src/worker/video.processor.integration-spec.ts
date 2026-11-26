import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Job, Queue, QueueEvents, UnrecoverableError } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { MediaFixtures } from '../test/media-fixtures';
import { TEST_S3_BUCKET, useTestBucket } from '../test/test-bucket';
import { useTestBackoffDelay, useTestQueuePrefix } from '../test/test-queue';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VideoProcessingQueue } from '../videos/video-processing.queue';
import { videoStorageKeys } from '../videos/videos.constants';
import { type ProcessVideoJobData, VideoStatus } from '../videos/videos.types';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const jobFor = (videoId: string) =>
  ({ id: videoId, data: { videoId } }) as Job<ProcessVideoJobData>;

describe('VideoProcessor (integration: Postgres + MinIO + FFmpeg)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let s3: S3Client;
  let processor: VideoProcessor;
  let fixtures: MediaFixtures;
  let restoreBucket: () => void;
  let validMp4: Buffer;
  let channel: Channel;
  const createdVideoIds: string[] = [];

  const objectKeysOf = async (videoId: string): Promise<string[]> => {
    const listing = await s3.send(
      new ListObjectsV2Command({
        Bucket: TEST_S3_BUCKET,
        Prefix: `videos/${videoId}/`,
      }),
    );
    return (listing.Contents ?? []).map(({ Key }) => Key!).sort();
  };

  /**
   * A `processing` video whose original object is `body` (as after `complete`);
   * `null` leaves the object missing in the storage.
   */
  const processingVideo = async (body: Buffer | null): Promise<Video> => {
    const id = randomUUID();
    createdVideoIds.push(id);
    if (body) {
      await storage.putObject(videoStorageKeys.original(id), body, 'video/mp4');
    }
    return videos.save({
      id,
      public_id: generatePublicId(),
      channel_id: channel.id,
      status: VideoStatus.PROCESSING,
      title: 'clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body?.length ?? 1024,
      storage_key: videoStorageKeys.original(id),
      upload_id: null,
      part_size: 67108864,
      part_count: 1,
    });
  };

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    fixtures = await MediaFixtures.create();
    validMp4 = await readFile(await fixtures.video('clip.mp4'));

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      // Instantiated in the test process; no BullMQ worker is started.
      providers: [VideoProcessor],
    }).compile();
    await moduleRef.init(); // ensureBucket() on the test bucket

    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = moduleRef.get(StorageService);
    s3 = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT);
    processor = moduleRef.get(VideoProcessor);
  }, 60_000);

  afterAll(async () => {
    for (const id of createdVideoIds) {
      for (const key of await objectKeysOf(id)) {
        await storage.deleteObject(key);
      }
    }
    await cleanAllTables(dataSource);
    await moduleRef.close();
    await fixtures.cleanup();
    restoreBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
  });

  it('should leave a processing MP4 ready with duration, metadata and a JPEG thumbnail in the bucket', async () => {
    const video = await processingVideo(validMp4);

    await processor.process(jobFor(video.id));

    const processed = await videos.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(2.9);
    expect(processed.duration_seconds).toBeLessThanOrEqual(3.1);
    expect(processed.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      formatName: expect.stringContaining('mp4') as string,
    });
    expect(processed.metadata!.bitrate).toBeGreaterThan(0);
    expect(processed.metadata!.sizeBytes).toBe(validMp4.length);
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    const thumbnail = await fetch(
      await storage.presignInternalGet(processed.thumbnail_key!),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    const jpeg = Buffer.from(await thumbnail.arrayBuffer());
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 60_000);

  it('should keep the same values and a single thumbnail object when the job is redelivered', async () => {
    const video = await processingVideo(validMp4);
    await processor.process(jobFor(video.id));
    const first = await videos.findOneByOrFail({ id: video.id });

    // Redelivery after a crash before ack: the video is processed again...
    await videos.update({ id: video.id }, { status: VideoStatus.PROCESSING });
    await processor.process(jobFor(video.id));
    // ...and a duplicate delivery after it is ready is a no-op.
    await processor.process(jobFor(video.id));

    const again = await videos.findOneByOrFail({ id: video.id });
    expect(again).toMatchObject({
      status: VideoStatus.READY,
      duration_seconds: first.duration_seconds,
      metadata: first.metadata,
      thumbnail_key: first.thumbnail_key,
    });
    expect(await objectKeysOf(video.id)).toEqual([
      `videos/${video.id}/original`,
      `videos/${video.id}/thumbnail.jpg`,
    ]);
  }, 60_000);

  it('should finish without error and without touching the row when the video is not processing', async () => {
    const video = await processingVideo(validMp4);
    await videos.update({ id: video.id }, { status: VideoStatus.DRAFT });
    const before = await videos.findOneByOrFail({ id: video.id });

    await expect(processor.process(jobFor(video.id))).resolves.toBeUndefined();

    expect(await videos.findOneByOrFail({ id: video.id })).toEqual(before);
    expect(await objectKeysOf(video.id)).toEqual([
      `videos/${video.id}/original`,
    ]);
  });

  it('should finish without error when the video does not exist', async () => {
    await expect(
      processor.process(jobFor(randomUUID())),
    ).resolves.toBeUndefined();
  });

  it('should throw UnrecoverableError for an object that is not a video and keep the row processing', async () => {
    const video = await processingVideo(Buffer.from('this is not a video\n'));

    const error = await processor
      .process(jobFor(video.id))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnrecoverableError);
    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.thumbnail_key).toBeNull();
  }, 30_000);

  it('should not change a ready video when a late failed event arrives', async () => {
    const video = await processingVideo(validMp4);
    await processor.process(jobFor(video.id));
    const ready = await videos.findOneByOrFail({ id: video.id });

    await processor.onFailed(
      {
        ...jobFor(video.id),
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job<ProcessVideoJobData>,
      new Error('late failure'),
    );

    expect(await videos.findOneByOrFail({ id: video.id })).toEqual(ready);
  }, 60_000);

  describe('final failure through the real queue (BullMQ worker in the test process)', () => {
    let queueModule: TestingModule;
    let queue: Queue;
    let queueEvents: QueueEvents;
    let producer: VideoProcessingQueue;
    let workerStorage: StorageService;
    let testPrefix: ReturnType<typeof useTestQueuePrefix>;
    let restoreBackoff: () => void;

    /** onFailed runs on the worker after the QueueEvents notice: wait for the row. */
    const waitForStatus = async (
      videoId: string,
      status: VideoStatus,
    ): Promise<Video> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const row = await videos.findOneByOrFail({ id: videoId });
        if (row.status === status || Date.now() > deadline) return row;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    /** Enqueues with the real job options and waits for the final failure. */
    const runUntilFailed = async (videoId: string): Promise<Job> => {
      await producer.enqueue(videoId);
      const job = (await queue.getJob(videoId))!;
      await expect(
        job.waitUntilFinished(queueEvents, 20_000),
      ).rejects.toThrow();
      return (await queue.getJob(videoId))!;
    };

    beforeAll(async () => {
      testPrefix = useTestQueuePrefix('video-processor');
      restoreBackoff = useTestBackoffDelay(100);

      queueModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [storageConfig, queueConfig],
          }),
          TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
          TypeOrmModule.forFeature([Video]),
          StorageModule,
          MediaModule,
          QueueModule,
        ],
        providers: [VideoProcessor, VideoProcessingQueue],
      }).compile();
      await queueModule.init(); // starts the BullMQ worker of VideoProcessor

      queue = queueModule.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEOS));
      producer = queueModule.get(VideoProcessingQueue);
      workerStorage = queueModule.get(StorageService);
      queueEvents = new QueueEvents(QUEUE_NAMES.VIDEOS, {
        connection: queue.opts.connection,
        prefix: testPrefix.prefix,
      });
      await queueEvents.waitUntilReady();
    }, 60_000);

    afterAll(async () => {
      await queueEvents.close();
      await queue.obliterate({ force: true });
      await queueModule.close(); // closes the worker and the queue
      restoreBackoff();
      testPrefix.restore();
    });

    it('should mark an unreadable object failed after a single attempt', async () => {
      const video = await processingVideo(Buffer.from('this is not a video\n'));

      const job = await runUntilFailed(video.id);

      expect(job.attemptsMade).toBe(1);
      const row = await waitForStatus(video.id, VideoStatus.FAILED);
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.failure_reason).toMatch(/ffprobe could not read the file/);
      expect(row.failure_reason).not.toMatch(/X-Amz-|https?:\/\//);
    }, 30_000);

    it('should retry a transient failure and mark it failed after exactly 3 attempts, staying processing in between', async () => {
      const video = await processingVideo(null); // object missing: ffprobe gets 404 (transient)
      const rowsAtAttemptStart: Pick<Video, 'status' | 'failure_reason'>[] = [];
      // `bind` is untyped here (strictBindCallApply: false), so type it back.
      const presign = workerStorage.presignInternalGet.bind(
        workerStorage,
      ) as StorageService['presignInternalGet'];
      const spy = jest
        .spyOn(workerStorage, 'presignInternalGet')
        .mockImplementation(async (key, expiresIn) => {
          const { status, failure_reason } = await videos.findOneByOrFail({
            id: video.id,
          });
          rowsAtAttemptStart.push({ status, failure_reason });
          return presign(key, expiresIn);
        });

      try {
        const job = await runUntilFailed(video.id);

        expect(job.attemptsMade).toBe(3);
        expect(rowsAtAttemptStart).toEqual([
          { status: VideoStatus.PROCESSING, failure_reason: null },
          { status: VideoStatus.PROCESSING, failure_reason: null },
          { status: VideoStatus.PROCESSING, failure_reason: null },
        ]);
        const row = await waitForStatus(video.id, VideoStatus.FAILED);
        expect(row.status).toBe(VideoStatus.FAILED);
        expect(row.failure_reason).toBe(
          'ffprobe failed: <source>: Server returned 404 Not Found',
        );
      } finally {
        spy.mockRestore();
      }
    }, 30_000);
  });
});
