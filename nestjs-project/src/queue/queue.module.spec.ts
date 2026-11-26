import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and expose the videos queue with the configured prefix', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEOS));
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe('videos');
    expect(queue.opts.prefix).toBe(
      moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY).prefix,
    );
    await moduleRef.close(); // closes the queue connection
  });
});
