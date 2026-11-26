export const VIDEO_UPLOAD_LIMITS = {
  /** 10 × 1024³ (phase-03-videos/TD-03). */
  MAX_SIZE_BYTES: 10_737_418_240,
  /** Fixed part size chosen at upload start: 64 MiB (TD-03). */
  PART_SIZE_BYTES: 67_108_864,
  /** Max part URLs signed per request (sugestão — sem origem normativa). */
  MAX_PARTS_PER_PRESIGN: 100,
  /** Lifetime of presigned upload-part URLs, in seconds (TD-03). */
  PART_URL_EXPIRES_IN_S: 3600,
  /** Highest part number S3 accepts in a multipart upload. */
  MAX_PART_NUMBER: 10_000,
} as const;

/** First-layer allowlist; ffprobe in the worker is the real check (TD-11). */
export const VIDEO_FORMAT_ALLOWLIST = {
  CONTENT_TYPES: [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
  ],
  EXTENSIONS: ['.mp4', '.mov', '.webm', '.mkv'],
} as const;

export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const videoStorageKeys = {
  original: (videoId: string) => `videos/${videoId}/original`,
  thumbnail: (videoId: string) => `videos/${videoId}/thumbnail.jpg`,
} as const;

/** `process-video` job on the `videos` queue (phase-03-videos/TD-10). */
export const PROCESS_VIDEO_JOB = {
  NAME: 'process-video',
  ATTEMPTS: 3,
} as const;

/** Owner detail (`GET /videos/:id`). */
export const VIDEO_DETAIL = {
  /** Lifetime of the presigned thumbnail GET URL, in seconds (phase-03-videos/TD-02). */
  THUMBNAIL_URL_EXPIRES_IN_S: 3600,
} as const;
