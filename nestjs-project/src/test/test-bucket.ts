import { overrideEnv } from './override-env';

/** Dedicated bucket so tests never touch dev objects (phase-03-videos/TD-13). */
export const TEST_S3_BUCKET = 'streamtube-test';

/**
 * Points `S3_BUCKET` at the test bucket. Call it before the testing module is
 * compiled (the `storage` namespace reads the env at that moment); the
 * returned function restores the previous value.
 */
export function useTestBucket(): () => void {
  return overrideEnv('S3_BUCKET', TEST_S3_BUCKET);
}
