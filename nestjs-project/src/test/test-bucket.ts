/** Dedicated bucket so tests never touch dev objects (phase-03-videos/TD-13). */
export const TEST_S3_BUCKET = 'streamtube-test';

/**
 * Points `S3_BUCKET` at the test bucket. Call it before the testing module is
 * compiled (the `storage` namespace reads the env at that moment); the
 * returned function restores the previous value.
 */
export function useTestBucket(): () => void {
  const previous = process.env.S3_BUCKET;
  process.env.S3_BUCKET = TEST_S3_BUCKET;
  return () => {
    process.env.S3_BUCKET = previous;
  };
}
