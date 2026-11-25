import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import { VideoProcessingQueue } from './video-processing.queue';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoTooLargeException,
} from './video.exceptions';
import { VideosService } from './videos.service';
import { VideoStatus } from './videos.types';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };
const PART_SIZE = 67108864;

const publicIdCollision = () =>
  Object.assign(
    new QueryFailedError('INSERT INTO "videos"', [], new Error('duplicate')),
    {
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    },
  );

describe('VideosService.initiateUpload', () => {
  let service: VideosService;
  let repo: { create: jest.Mock; save: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let channels: { findByUserId: jest.Mock };

  const dto = (
    overrides: Partial<InitiateUploadDto> = {},
  ): InitiateUploadDto => ({
    file_name: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 134217728,
    ...overrides,
  });

  beforeEach(async () => {
    repo = {
      create: jest.fn((fields: Partial<Video>) => ({
        status: VideoStatus.DRAFT,
        ...fields,
      })),
      save: jest.fn((video: Video) => Promise.resolve(video)),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
        { provide: VideoProcessingQueue, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  afterEach(() => jest.restoreAllMocks());

  const expectNoWrites = () => {
    expect(repo.save).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  };

  describe('size limit (413)', () => {
    it('should reject size_bytes above 10737418240 without touching repo or storage', async () => {
      await expect(
        service.initiateUpload(USER_ID, dto({ size_bytes: 10737418241 })),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expectNoWrites();
    });

    it('should accept exactly 10737418240 bytes (inclusive limit)', async () => {
      const result = await service.initiateUpload(
        USER_ID,
        dto({ size_bytes: 10737418240 }),
      );

      expect(result.part_count).toBe(160);
    });
  });

  describe('format allowlist (415)', () => {
    it.each([
      ['an unsupported content_type', { content_type: 'image/png' }],
      ['an unsupported extension', { file_name: 'clip.avi' }],
      ['a file name without extension', { file_name: 'clip' }],
    ])(
      'should reject %s without touching repo or storage',
      async (_label, overrides) => {
        await expect(
          service.initiateUpload(USER_ID, dto(overrides)),
        ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
        expectNoWrites();
      },
    );

    it.each([
      ['CLIP.MOV', 'video/quicktime'],
      ['movie.WebM', 'VIDEO/WEBM'],
      ['film.mkv', 'video/x-matroska'],
    ])(
      'should accept %s / %s case-insensitively',
      async (fileName, contentType) => {
        await expect(
          service.initiateUpload(
            USER_ID,
            dto({ file_name: fileName, content_type: contentType }),
          ),
        ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
      },
    );
  });

  describe('draft creation', () => {
    it.each([
      [1, 1],
      [PART_SIZE, 1],
      [PART_SIZE + 1, 2],
      [134217728, 2],
    ])(
      'should compute part_count for size_bytes=%d as %d',
      async (sizeBytes, expected) => {
        const result = await service.initiateUpload(
          USER_ID,
          dto({ size_bytes: sizeBytes }),
        );

        expect(result.part_size).toBe(PART_SIZE);
        expect(result.part_count).toBe(expected);
      },
    );

    it('should open the multipart at videos/{id}/original and persist the draft in the caller channel', async () => {
      const result = await service.initiateUpload(USER_ID, dto());

      expect(channels.findByUserId).toHaveBeenCalledWith(USER_ID);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original`,
        'video/mp4',
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          channel_id: CHANNEL.id,
          storage_key: `videos/${result.id}/original`,
          upload_id: 'upload-id',
          original_filename: 'clip.mp4',
        }),
      );
    });

    it('should retry with a new public_id when the first one collides', async () => {
      jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce('taken______')
        .mockReturnValueOnce('fresh______');
      repo.save
        .mockRejectedValueOnce(publicIdCollision())
        .mockImplementationOnce((video: Video) => Promise.resolve(video));

      const result = await service.initiateUpload(USER_ID, dto());

      expect(repo.save).toHaveBeenCalledTimes(2);
      expect(result.public_id).toBe('fresh______');
      expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should abort the multipart and rethrow when persisting the draft fails', async () => {
      const dbError = new Error('connection lost');
      repo.save.mockRejectedValueOnce(dbError);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        dbError,
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-id',
      );
    });
  });
});

describe('VideosService.findOwnedDraft / presignParts', () => {
  let service: VideosService;
  let repo: { findOne: jest.Mock };
  let storage: { presignUploadPart: jest.Mock };
  let channels: { findByUserId: jest.Mock };

  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-1',
      channel_id: CHANNEL.id,
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-id',
      part_size: PART_SIZE,
      part_count: 3,
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    repo = { findOne: jest.fn().mockResolvedValue(draft()) };
    storage = {
      presignUploadPart: jest.fn((_key: string, _uploadId: string, n: number) =>
        Promise.resolve(`http://localhost:9000/part-${n}`),
      ),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
        { provide: VideoProcessingQueue, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  describe('findOwnedDraft', () => {
    it('should look the video up restricted to the caller channel', async () => {
      await service.findOwnedDraft(USER_ID, 'video-1');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'video-1', channel_id: CHANNEL.id },
      });
    });

    it('should throw VideoNotFoundException for a video of another channel', async () => {
      repo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.findOwnedDraft(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw VideoNotFoundException when the caller has no channel', async () => {
      channels.findByUserId.mockResolvedValueOnce(null);

      await expect(
        service.findOwnedDraft(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw VideoNotInDraftException when status is %s',
      async (status) => {
        repo.findOne.mockResolvedValueOnce(draft({ status, upload_id: null }));

        await expect(
          service.findOwnedDraft(USER_ID, 'video-1'),
        ).rejects.toBeInstanceOf(VideoNotInDraftException);
      },
    );
  });

  describe('presignParts', () => {
    it('should throw InvalidPartNumberException when an item is above part_count, without signing', async () => {
      await expect(
        service.presignParts(USER_ID, 'video-1', [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should accept the last part (n = part_count)', async () => {
      await expect(
        service.presignParts(USER_ID, 'video-1', [3]),
      ).resolves.toMatchObject({ parts: [{ part_number: 3 }] });
    });

    it('should return the parts in ascending order with expires_in 3600', async () => {
      const result = await service.presignParts(USER_ID, 'video-1', [3, 1, 2]);

      expect(result).toEqual({
        parts: [
          { part_number: 1, url: 'http://localhost:9000/part-1' },
          { part_number: 2, url: 'http://localhost:9000/part-2' },
          { part_number: 3, url: 'http://localhost:9000/part-3' },
        ],
        expires_in: 3600,
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-id',
        1,
        3600,
      );
    });

    it('should propagate VideoNotInDraftException without signing', async () => {
      repo.findOne.mockResolvedValueOnce(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.presignParts(USER_ID, 'video-1', [1]),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });
});

describe('VideosService.completeUpload', () => {
  let service: VideosService;
  let repo: { findOne: jest.Mock; update: jest.Mock; delete: jest.Mock };
  let storage: {
    completeMultipartUpload: jest.Mock;
    headObjectSize: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queue: { enqueue: jest.Mock };

  const SIZE = 1024;
  const PARTS = [
    { part_number: 2, etag: '"etag-2"' },
    { part_number: 1, etag: '"etag-1"' },
  ];

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'video-1',
        public_id: 'Xk3_9aQpL0w',
        channel_id: CHANNEL.id,
        status: VideoStatus.DRAFT,
        storage_key: 'videos/video-1/original',
        upload_id: 'upload-id',
        size_bytes: SIZE,
        part_size: PART_SIZE,
        part_count: 2,
      } as Video),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObjectSize: jest.fn().mockResolvedValue(SIZE),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn().mockResolvedValue(CHANNEL) },
        },
        { provide: VideoProcessingQueue, useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  it('should complete with the mapped parts, move to processing conditionally and enqueue', async () => {
    const result = await service.completeUpload(USER_ID, 'video-1', PARTS);

    expect(result).toEqual({
      id: 'video-1',
      public_id: 'Xk3_9aQpL0w',
      status: VideoStatus.PROCESSING,
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-id',
      [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: '"etag-1"' },
      ],
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    expect(queue.enqueue).toHaveBeenCalledWith('video-1');
  });

  it('should map StorageInvalidPartsError to InvalidUploadPartsException and keep the draft', async () => {
    storage.completeMultipartUpload.mockRejectedValueOnce(
      new StorageInvalidPartsError('InvalidPart', 'bad etag'),
    );

    await expect(
      service.completeUpload(USER_ID, 'video-1', PARTS),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('should propagate other storage errors unchanged', async () => {
    const outage = new Error('connect ECONNREFUSED');
    storage.completeMultipartUpload.mockRejectedValueOnce(outage);

    await expect(
      service.completeUpload(USER_ID, 'video-1', PARTS),
    ).rejects.toBe(outage);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['larger', SIZE + 1],
    ['smaller', SIZE - 1],
  ])(
    'should delete the object and the draft without enqueueing when the real size is %s',
    async (_label, actualSize) => {
      storage.headObjectSize.mockResolvedValueOnce(actualSize);

      await expect(
        service.completeUpload(USER_ID, 'video-1', PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repo.delete).toHaveBeenCalledWith({ id: 'video-1' });
      expect(repo.update).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    },
  );

  it('should throw VideoNotInDraftException without enqueueing when the conditional update affects 0 rows', async () => {
    repo.update.mockResolvedValueOnce({ affected: 0 });

    await expect(
      service.completeUpload(USER_ID, 'video-1', PARTS),
    ).rejects.toBeInstanceOf(VideoNotInDraftException);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('should not call the storage when the video is no longer in draft', async () => {
    repo.findOne.mockResolvedValueOnce({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      upload_id: null,
    } as Video);

    await expect(
      service.completeUpload(USER_ID, 'video-1', PARTS),
    ).rejects.toBeInstanceOf(VideoNotInDraftException);
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('VideosService.abortUpload', () => {
  let service: VideosService;
  let repo: { findOne: jest.Mock; delete: jest.Mock };
  let storage: { abortMultipartUpload: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'video-1',
        channel_id: CHANNEL.id,
        status: VideoStatus.DRAFT,
        storage_key: 'videos/video-1/original',
        upload_id: 'upload-id',
      } as Video),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = { abortMultipartUpload: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn().mockResolvedValue(CHANNEL) },
        },
        { provide: VideoProcessingQueue, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  it('should abort the multipart and delete the draft row', async () => {
    await service.abortUpload(USER_ID, 'video-1');

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-id',
    );
    expect(repo.delete).toHaveBeenCalledWith({
      id: 'video-1',
      status: VideoStatus.DRAFT,
    });
  });

  it('should still delete the row when the storage answers NoSuchUpload', async () => {
    storage.abortMultipartUpload.mockRejectedValueOnce(
      new StorageUploadNotFoundError('The specified upload does not exist'),
    );

    await expect(
      service.abortUpload(USER_ID, 'video-1'),
    ).resolves.toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith({
      id: 'video-1',
      status: VideoStatus.DRAFT,
    });
  });

  it('should propagate other storage errors and keep the row', async () => {
    const outage = new Error('connect ECONNREFUSED');
    storage.abortMultipartUpload.mockRejectedValueOnce(outage);

    await expect(service.abortUpload(USER_ID, 'video-1')).rejects.toBe(outage);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('should throw VideoNotInDraftException for a video in processing without calling the storage', async () => {
    repo.findOne.mockResolvedValueOnce({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      upload_id: null,
    } as Video);

    await expect(
      service.abortUpload(USER_ID, 'video-1'),
    ).rejects.toBeInstanceOf(VideoNotInDraftException);
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
