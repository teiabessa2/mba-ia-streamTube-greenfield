/**
 * The file is not a readable video (no video stream, unreadable container or
 * ffprobe output). Permanent: retrying cannot fix it, so the worker turns it
 * into an `UnrecoverableError` (phase-03-videos/TD-10, TD-11).
 */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}
