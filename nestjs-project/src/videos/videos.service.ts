import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from './video.exceptions';
import {
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_FORMAT_ALLOWLIST,
  VIDEO_UPLOAD_LIMITS,
  videoStorageKeys,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

/** Postgres driver fields that TypeORM copies onto QueryFailedError. */
interface PgErrorFields {
  code?: unknown;
  detail?: unknown;
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes('public_id')
  );
}

const isAllowedFormat = (fileName: string, contentType: string): boolean => {
  const extension = extname(fileName).toLowerCase();
  const mime = contentType.toLowerCase();
  return (
    (VIDEO_FORMAT_ALLOWLIST.CONTENT_TYPES as readonly string[]).includes(
      mime,
    ) &&
    (VIDEO_FORMAT_ALLOWLIST.EXTENSIONS as readonly string[]).includes(extension)
  );
};

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Validates the declared file, opens the S3 multipart upload and persists the
   * draft. No video bytes go through the API (phase-03-videos/TD-03).
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    if (dto.size_bytes > VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    if (!isAllowedFormat(dto.file_name, dto.content_type)) {
      throw new UnsupportedVideoFormatException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every registered user gets a channel at sign-up (phase 02).
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = videoStorageKeys.original(id);
    const partSize = VIDEO_UPLOAD_LIMITS.PART_SIZE_BYTES;
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    try {
      const video = await this.saveDraftWithUniquePublicId({
        id,
        channel_id: channel.id,
        original_filename: dto.file_name,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
        part_size: partSize,
        part_count: Math.ceil(dto.size_bytes / partSize),
      });
      return {
        id: video.id,
        public_id: video.public_id,
        status: video.status,
        part_size: video.part_size,
        part_count: video.part_count,
      };
    } catch (err) {
      // No draft row points at this multipart upload: discard it, then rethrow.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }
  }

  private async saveDraftWithUniquePublicId(
    fields: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt >= PUBLIC_ID_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
