/** Lifecycle of a video (phase-03-videos/TD-09). */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** Technical metadata extracted by `ffprobe`, stored as-is (phase-03-videos/TD-05). */
export type { MediaMetadata as VideoMetadata } from '../media/media.types';

/** Payload of the `process-video` job (see Events/Messages). */
export interface ProcessVideoJobData {
  videoId: string;
}

/** How a ready video is delivered by the public playback routes (TD-08). */
export type PlaybackMode = 'stream' | 'download';
