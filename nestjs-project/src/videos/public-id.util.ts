import { randomBytes } from 'node:crypto';

const PUBLIC_ID_BYTES = 8;

/**
 * Short, non-enumerable public video id: 8 random bytes in base64url
 * (11 characters, `[A-Za-z0-9_-]`), per phase-03-videos/TD-07.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
