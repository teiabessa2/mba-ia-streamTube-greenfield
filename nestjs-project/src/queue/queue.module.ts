import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Redis connection and the `videos` queue (phase-03-videos/TD-01). Every queue,
 * worker and QueueEvents shares the `QUEUE_PREFIX` prefix (TD-04, TD-13).
 * Imported by `VideosModule` (producer) and later by the worker module.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueue({ name: QUEUE_NAMES.VIDEOS }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
