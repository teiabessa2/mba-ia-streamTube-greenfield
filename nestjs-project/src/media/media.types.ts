/** Time limits for the ffprobe/ffmpeg child processes. */
export interface MediaOptions {
  probeTimeoutMs: number;
  frameTimeoutMs: number;
}

/** Technical metadata extracted by `ffprobe` (phase-03-videos/TD-05). */
export interface MediaMetadata {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
  bitrate: number;
  formatName: string;
  sizeBytes: number;
}

export interface ProbeResult {
  durationSeconds: number;
  metadata: MediaMetadata;
}
