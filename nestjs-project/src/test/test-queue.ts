/**
 * Points `QUEUE_PREFIX` at a prefix unique to the suite, so its jobs never mix
 * with dev or other suites (phase-03-videos/TD-13). Call it before the testing
 * module is compiled; the returned function restores the previous value.
 */
export function useTestQueuePrefix(suite: string): {
  prefix: string;
  restore: () => void;
} {
  const previous = process.env.QUEUE_PREFIX;
  const prefix = `test-${suite}-${Date.now()}`;
  process.env.QUEUE_PREFIX = prefix;
  return {
    prefix,
    restore: () => {
      process.env.QUEUE_PREFIX = previous;
    },
  };
}
