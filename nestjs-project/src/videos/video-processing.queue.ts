import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { PROCESS_VIDEO_JOB } from './videos.constants';
import type { ProcessVideoJobData } from './videos.types';

/** Producer of the `process-video` job (phase-03-videos/TD-01, TD-10). */
@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(QUEUE_NAMES.VIDEOS)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /** `jobId = videoId` deduplicates a re-send while the job is still stored. */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB.NAME,
      { videoId },
      {
        attempts: PROCESS_VIDEO_JOB.ATTEMPTS,
        backoff: { type: 'exponential', delay: this.config.backoffDelayMs },
        jobId: videoId,
        removeOnComplete: true,
      },
    );
  }
}
