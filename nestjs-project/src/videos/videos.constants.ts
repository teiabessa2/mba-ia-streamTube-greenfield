export const VIDEO_UPLOAD_LIMITS = {
  /** 10 × 1024³ (phase-03-videos/TD-03). */
  MAX_SIZE_BYTES: 10_737_418_240,
  /** Fixed part size chosen at upload start: 64 MiB (TD-03). */
  PART_SIZE_BYTES: 67_108_864,
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
} as const;
