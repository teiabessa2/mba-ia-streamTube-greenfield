/** DI tokens for the two S3 clients (phase-03-videos/TD-02). */
export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

export const STORAGE_DEFAULTS = {
  /** Presigned upload-part URL lifetime (TD-03 suggests 1h). */
  UPLOAD_PART_EXPIRES_IN_S: 3600,
  /** Presigned GET read by ffprobe/ffmpeg inside the worker (TD-06). */
  INTERNAL_GET_EXPIRES_IN_S: 900,
} as const;

/** Boot wait for the storage, which has no Compose healthcheck (TD-02 restriction 4). */
export const STORAGE_BOOT = {
  RETRY_TIMEOUT_MS: 30_000,
  RETRY_INTERVAL_MS: 1_000,
} as const;

/** S3 error names that mean the parts sent to CompleteMultipartUpload are unusable. */
export const INVALID_PARTS_ERROR_NAMES: readonly string[] = [
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
];
