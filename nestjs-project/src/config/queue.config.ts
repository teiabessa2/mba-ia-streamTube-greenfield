import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST ?? 'redis',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  // Shared by every Queue, Worker and QueueEvents; tests use a unique one per suite.
  prefix: process.env.QUEUE_PREFIX ?? 'streamtube',
  backoffDelayMs: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS ?? '30000', 10),
}));
