import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import type { Repository } from 'typeorm';
import { InvalidMediaError } from '../media/media.errors';
import { MediaService } from '../media/media.service';
import type { ProbeResult } from '../media/media.types';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { STORAGE_DEFAULTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { videoStorageKeys } from '../videos/videos.constants';
import { type ProcessVideoJobData, VideoStatus } from '../videos/videos.types';
import { THUMBNAIL } from './worker.constants';

/**
 * Consumer of the `process-video` job (see Events/Messages). Runs only in the
 * worker entrypoint (phase-03-videos/TD-04). At-least-once delivery: a job
 * for a video that already left `processing` is a no-op (TD-01).
 */
@Processor(QUEUE_NAMES.VIDEOS)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videos.findOneBy({ id: videoId });
    if (video?.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Skipping job ${job.id}: video ${videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    // Internal client: ffprobe/ffmpeg read inside the Compose network (TD-06).
    const sourceUrl = await this.storage.presignInternalGet(
      video.storage_key,
      STORAGE_DEFAULTS.INTERNAL_GET_EXPIRES_IN_S,
    );
    const probe = await this.probe(sourceUrl);
    const thumbnailKey = await this.uploadThumbnail(
      videoId,
      sourceUrl,
      probe.durationSeconds,
    );

    await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        duration_seconds: probe.durationSeconds,
        metadata: probe.metadata,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
      },
    );
    this.logger.log(`Video ${videoId} is ready`);
  }

  /** Unreadable media never succeeds on retry, so it skips the attempts (TD-11). */
  private async probe(url: string): Promise<ProbeResult> {
    try {
      return await this.media.probe(url);
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async uploadThumbnail(
    videoId: string,
    sourceUrl: string,
    durationSeconds: number,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), THUMBNAIL.TEMP_DIR_PREFIX));
    try {
      const framePath = join(dir, THUMBNAIL.TEMP_FILE_NAME);
      await this.media.extractFrame(
        sourceUrl,
        durationSeconds * THUMBNAIL.FRAME_POSITION_RATIO,
        framePath,
      );
      // Same key on every run: reprocessing overwrites a single object.
      const key = videoStorageKeys.thumbnail(videoId);
      await this.storage.putObject(
        key,
        await readFile(framePath),
        THUMBNAIL.CONTENT_TYPE,
      );
      return key;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
