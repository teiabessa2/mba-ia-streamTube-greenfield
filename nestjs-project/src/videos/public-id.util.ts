import { randomBytes } from 'node:crypto';

const PUBLIC_ID_BYTES = 8;

/** Base64url of `PUBLIC_ID_BYTES` bytes: always 11 characters, no padding. */
const PUBLIC_ID_FORMAT = /^[A-Za-z0-9_-]{11}$/;

/**
 * Short, non-enumerable public video id: 8 random bytes in base64url
 * (11 characters, `[A-Za-z0-9_-]`), per phase-03-videos/TD-07.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}

/** Whether `value` has the shape produced by `generatePublicId`. */
export function isPublicIdFormat(value: string): boolean {
  return PUBLIC_ID_FORMAT.test(value);
}
