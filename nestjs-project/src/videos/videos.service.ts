import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadPartDto } from './dto/complete-upload.dto';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import type { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { generatePublicId, isPublicIdFormat } from './public-id.util';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideoStatus, type PlaybackMode } from './videos.types';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoTooLargeException,
} from './video.exceptions';
import {
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_DETAIL,
  VIDEO_FORMAT_ALLOWLIST,
  VIDEO_PLAYBACK,
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

const DEL_CHAR_CODE = 0x7f;
const FIRST_PRINTABLE_CHAR_CODE = 0x20;

/** Whether `char` would break a header quoted-string: `"`, `\` or a control character. */
const isUnsafeInQuotedString = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    code < FIRST_PRINTABLE_CHAR_CODE ||
    code === DEL_CHAR_CODE ||
    char === '"' ||
    char === '\\'
  );
};

/** `attachment; filename="..."` with the unsafe characters removed. */
const attachmentDisposition = (fileName: string): string => {
  const safeName = Array.from(fileName)
    .filter((char) => !isUnsafeInQuotedString(char))
    .join('');
  return `attachment; filename="${safeName}"`;
};

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
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

  /**
   * Loads a video of the caller's channel, in any status. Missing or foreign
   * videos are reported as not found, without revealing that they exist
   * (phase-03-videos/TD-08).
   */
  async findOwned(userId: string, id: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOne({
          where: { id, channel_id: channel.id },
        })
      : null;
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /** Owner detail: status, extracted metadata and a presigned thumbnail URL. */
  async getOwnedDetail(userId: string, id: string): Promise<VideoResponseDto> {
    const video = await this.findOwned(userId, id);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGet(video.thumbnail_key, {
          expiresIn: VIDEO_DETAIL.THUMBNAIL_URL_EXPIRES_IN_S,
        })
      : null;
    return VideoResponseDto.from(video, thumbnailUrl);
  }

  /**
   * Loads a video by its public id, only when `ready`. A missing id, a
   * malformed one and a video in any other status give the same not found,
   * for any caller (phase-03-videos/TD-08 revisão 2026-11-23, TD-07).
   */
  async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = isPublicIdFormat(publicId)
      ? await this.videoRepository.findOne({
          where: { public_id: publicId, status: VideoStatus.READY },
        })
      : null;
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /**
   * Presigned GET (public client) for the original object of a ready video.
   * `download` adds `Content-Disposition: attachment` with the original file
   * name; the storage serves `Range` natively for `stream` (TD-08, TD-02).
   */
  async getPlaybackUrl(publicId: string, mode: PlaybackMode): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storageService.presignGet(video.storage_key, {
      expiresIn: VIDEO_PLAYBACK.URL_EXPIRES_IN_S,
      contentType: video.content_type,
      ...(mode === 'download' && {
        contentDisposition: attachmentDisposition(video.original_filename),
      }),
    });
  }

  /** Loads a draft (with an open multipart upload) owned by the caller. */
  async findOwnedDraft(userId: string, id: string): Promise<Video> {
    const video = await this.findOwned(userId, id);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotInDraftException();
    }
    return video;
  }

  /** Signs (or re-signs) PUT URLs for the requested parts, in ascending order. */
  async presignParts(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<PresignPartsResponseDto> {
    const video = await this.findOwnedDraft(userId, id);
    if (partNumbers.some((n) => n > video.part_count)) {
      throw new InvalidPartNumberException(video.part_count);
    }

    const expiresIn = VIDEO_UPLOAD_LIMITS.PART_URL_EXPIRES_IN_S;
    const uploadId = video.upload_id as string;
    const sorted = [...partNumbers].sort((a, b) => a - b);
    const parts = await Promise.all(
      sorted.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expires_in: expiresIn };
  }

  /** Lists the parts the storage already received, to resume an upload. */
  async listUploadedParts(
    userId: string,
    id: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findOwnedDraft(userId, id);
    const uploaded = await this.storageService.listParts(
      video.storage_key,
      video.upload_id as string,
    );
    return {
      parts: uploaded
        .map((p) => ({
          part_number: p.partNumber,
          etag: p.etag,
          size_bytes: p.sizeBytes,
        }))
        .sort((a, b) => a.part_number - b.part_number),
      part_size: video.part_size,
      part_count: video.part_count,
    };
  }

  /**
   * Completes the multipart, checks the real object size against the declared
   * one and moves the draft to `processing`, publishing `process-video`
   * (phase-03-videos/TD-03, TD-09).
   */
  async completeUpload(
    userId: string,
    id: string,
    parts: CompleteUploadPartDto[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedDraft(userId, id);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      );
    } catch (err) {
      // The multipart stays open: the draft is kept and can be resumed.
      if (err instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      throw err;
    }

    // A smaller declared size must not bypass the 10GB limit (TD-03).
    const actualSize = await this.storageService.headObjectSize(
      video.storage_key,
    );
    if (actualSize !== video.size_bytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.delete({ id: video.id });
      throw new UploadSizeMismatchException();
    }

    // Conditional on draft, so a concurrent complete cannot enqueue twice.
    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    if (!result.affected) throw new VideoNotInDraftException();

    await this.videoProcessingQueue.enqueue(video.id);
    return {
      id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /**
   * Gives up a draft: discards the uploaded parts and deletes the row. There is
   * no "aborted" status (phase-03-videos/TD-12).
   */
  async abortUpload(userId: string, id: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, id);

    try {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id as string,
      );
    } catch (err) {
      // Already gone in the storage (expired/aborted): the end state is the same.
      if (!(err instanceof StorageUploadNotFoundError)) throw err;
    }

    await this.videoRepository.delete({
      id: video.id,
      status: VideoStatus.DRAFT,
    });
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
