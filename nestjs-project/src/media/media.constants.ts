/** DI token for the ffprobe/ffmpeg time limits (`MediaOptions`). */
export const MEDIA_OPTIONS = 'MEDIA_OPTIONS';

export const MEDIA_DEFAULTS = {
  /** ffprobe only reads headers through HTTP range requests (TD-06). */
  PROBE_TIMEOUT_MS: 30_000,
  /** One frame after an input seek, also through HTTP range requests (TD-06). */
  FRAME_TIMEOUT_MS: 60_000,
  /** stdout limit for the ffprobe JSON (many streams still fit easily). */
  PROBE_MAX_BUFFER_BYTES: 10 * 1024 * 1024,
} as const;

/**
 * ffprobe stderr fragments that mean the file itself is unreadable as media.
 * Any other non-zero exit (403, DNS, connection refused, I/O) is transient
 * (phase-03-videos/TD-10, TD-11).
 */
export const INVALID_MEDIA_STDERR_PATTERNS: readonly RegExp[] = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
];
