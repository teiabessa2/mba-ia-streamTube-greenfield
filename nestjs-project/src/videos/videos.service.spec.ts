import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import {
  UnsupportedVideoFormatException,
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
