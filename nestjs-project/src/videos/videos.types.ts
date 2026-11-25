/** Lifecycle of a video (phase-03-videos/TD-09). */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** Technical metadata extracted by `ffprobe` (phase-03-videos/TD-05). */
export interface VideoMetadata {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
  bitrate: number;
  formatName: string;
  sizeBytes: number;
}

/** Payload of the `process-video` job (see Events/Messages). */
export interface ProcessVideoJobData {
  videoId: string;
}
