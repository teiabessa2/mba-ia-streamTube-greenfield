import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { useTestQueuePrefix } from '../test/test-queue';
import { VideoProcessingQueue } from './video-processing.queue';
import type { ProcessVideoJobData } from './videos.types';

describe('VideoProcessingQueue (integration: Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingQueue;
  let queue: Queue<ProcessVideoJobData>;
  let testPrefix: ReturnType<typeof useTestQueuePrefix>;

  beforeAll(async () => {
    testPrefix = useTestQueuePrefix('video-processing-queue');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoProcessingQueue],
    }).compile();
    producer = moduleRef.get(VideoProcessingQueue);
    queue = moduleRef.get<Queue<ProcessVideoJobData>>(
      getQueueToken(QUEUE_NAMES.VIDEOS),
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
    testPrefix.restore();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should add process-video with jobId = videoId, 3 attempts and exponential backoff', async () => {
    const videoId = '6f1c2a4e-0d7b-4c39-9a51-2b8e3f4d5c6a';

    await producer.enqueue(videoId);

    expect(queue.opts.prefix).toBe(testPrefix.prefix);
    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe('process-video');
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY)
          .backoffDelayMs,
      },
      jobId: videoId,
      removeOnComplete: true,
    });
  });

  it('should not duplicate the job when the same video is enqueued twice', async () => {
    const videoId = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.data?.videoId === videoId)).toHaveLength(1);
  });
});
