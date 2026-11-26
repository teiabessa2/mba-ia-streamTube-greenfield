import { overrideEnv } from './override-env';

/**
 * Points `QUEUE_PREFIX` at a prefix unique to the suite, so its jobs never mix
 * with dev or other suites (phase-03-videos/TD-13). Call it before the testing
 * module is compiled; the returned function restores the previous value.
 */
export function useTestQueuePrefix(suite: string): {
  prefix: string;
  restore: () => void;
} {
  const prefix = `test-${suite}-${Date.now()}`;
  return { prefix, restore: overrideEnv('QUEUE_PREFIX', prefix) };
}

/**
 * Shortens the retry backoff (`QUEUE_BACKOFF_DELAY_MS`) so retry scenarios run
 * fast. Call it before the testing module is compiled; the returned function
 * restores the previous value.
 */
export function useTestBackoffDelay(ms: number): () => void {
  return overrideEnv('QUEUE_BACKOFF_DELAY_MS', String(ms));
}
