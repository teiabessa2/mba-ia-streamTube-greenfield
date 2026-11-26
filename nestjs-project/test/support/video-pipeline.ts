import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import type { App } from 'supertest/types';
import { QUEUE_NAMES } from '../../src/queue/queue.constants';
import {
  requestPresigned,
  type PresignedResponse,
} from '../../src/test/presigned-http';
import { useTestBucket } from '../../src/test/test-bucket';
import { useTestQueuePrefix } from '../../src/test/test-queue';
import { WorkerModule } from '../../src/worker/worker.module';
import { createVideosE2eApp } from './videos-e2e';

/** Retry delay of the `process-video` job inside the pipeline suites. */
const TEST_BACKOFF_DELAY_MS = '100';

/** How a job of the `videos` queue ended, as seen by `QueueEvents`. */
export type JobOutcome =
  | { state: 'completed' }
  | { state: 'failed'; failedReason: string };

/** Body-carrying request received by the API (method, path and headers). */
export interface RecordedApiRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  contentLength: number;
}

export interface VideoPipeline {
  app: INestApplication<App>;
  queue: Queue;
  /**
   * Resolves when the job `videoId` completes or fails. Call it **before**
   * the action that enqueues the job: jobs are removed on completion, so a
   * listener registered afterwards could miss the event.
   */
  waitForJob(videoId: string, timeoutMs?: number): Promise<JobOutcome>;
  /** Requests with a body received by the API since the last `reset()`. */
  apiRequests: { list: RecordedApiRequest[]; reset(): void };
  close(): Promise<void>;
}

/**
 * Boots the API (`AppModule` with the global config of `main.ts`) and the
 * video worker (`WorkerModule`) in the test process, on the test bucket and a
 * queue prefix unique to the suite, so the Compose `video-worker` never takes
 * these jobs (phase-03-videos/TD-13, TD-04).
 */
export async function createVideoPipeline(
  suite: string,
): Promise<VideoPipeline> {
  const restoreBucket = useTestBucket();
  const queuePrefix = useTestQueuePrefix(suite);
  const previousBackoff = process.env.QUEUE_BACKOFF_DELAY_MS;
  process.env.QUEUE_BACKOFF_DELAY_MS = TEST_BACKOFF_DELAY_MS;

  const app = await createVideosE2eApp();
  const worker: TestingModule = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();
  await worker.init(); // starts the BullMQ worker of VideoProcessor

  const queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEOS));
  const queueEvents = new QueueEvents(QUEUE_NAMES.VIDEOS, {
    connection: queue.opts.connection,
    prefix: queuePrefix.prefix,
  });
  await queueEvents.waitUntilReady();

  const recorded: RecordedApiRequest[] = [];
  const record = (req: IncomingMessage) => {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength === 0) return;
    recorded.push({
      method: req.method ?? '',
      url: req.url ?? '',
      contentType: req.headers['content-type'],
      contentLength,
    });
  };
  // Runs before Express, for every request supertest sends to this server.
  (app.getHttpServer() as Server).prependListener('request', record);

  const waitForJob = (videoId: string, timeoutMs = 30_000) =>
    new Promise<JobOutcome>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        queueEvents.off('completed', onCompleted);
        queueEvents.off('failed', onFailed);
      };
      const onCompleted = ({ jobId }: { jobId: string }) => {
        if (jobId !== videoId) return;
        done();
        resolve({ state: 'completed' });
      };
      const onFailed = ({
        jobId,
        failedReason,
      }: {
        jobId: string;
        failedReason: string;
      }) => {
        if (jobId !== videoId) return;
        done();
        resolve({ state: 'failed', failedReason });
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Job ${videoId} did not finish in ${timeoutMs}ms`));
      }, timeoutMs);
      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
    });

  return {
    app,
    queue,
    waitForJob,
    apiRequests: {
      list: recorded,
      reset: () => {
        recorded.splice(0);
      },
    },
    close: async () => {
      await queueEvents.close();
      await queue.obliterate({ force: true });
      await worker.close(); // closes the BullMQ worker (onApplicationShutdown)
      await app.close();
      if (previousBackoff === undefined) {
        delete process.env.QUEUE_BACKOFF_DELAY_MS;
      } else {
        process.env.QUEUE_BACKOFF_DELAY_MS = previousBackoff;
      }
      queuePrefix.restore();
      restoreBucket();
    },
  };
}

/** PUT of one part on its presigned URL; returns the `ETag` from the storage. */
export async function putPart(url: string, chunk: Buffer): Promise<string> {
  const res = await requestPresigned(url, { method: 'PUT', body: chunk });
  const etag = res.headers.etag;
  if (res.statusCode !== 200 || typeof etag !== 'string') {
    throw new Error(
      `Part PUT failed with ${res.statusCode}: ${res.body.toString()}`,
    );
  }
  return etag;
}

/** GET on a presigned stream `Location`, optionally with a `Range` header. */
export function getStream(
  location: string,
  range?: string,
): Promise<PresignedResponse> {
  return requestPresigned(location, {
    method: 'GET',
    ...(range && { headers: { Range: range } }),
  });
}

/** GET on a presigned download `Location`. */
export function getDownload(location: string): Promise<PresignedResponse> {
  return requestPresigned(location, { method: 'GET' });
}
