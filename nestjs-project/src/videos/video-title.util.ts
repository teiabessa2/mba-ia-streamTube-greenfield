import { VIDEO_TITLE } from './videos.constants';

/** Last extension of a file name: a dot followed by at least one non-dot. */
const LAST_EXTENSION = /\.[^.]+$/;

/** Keeps the first `max` characters, counted by code point like Postgres `varchar`. */
const truncate = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join('');

/**
 * Title used when `POST /videos` has none: the file name without its last
 * extension, trimmed; when that is empty (e.g. `.mp4`, ` .mp4`), the trimmed
 * file name itself. Capped at `VIDEO_TITLE.MAX_LENGTH` characters.
 * The `AddVideoTitle` migration backfills existing rows with this same rule.
 */
export function deriveVideoTitle(fileName: string): string {
  const withoutExtension = fileName.replace(LAST_EXTENSION, '').trim();
  return truncate(withoutExtension || fileName.trim(), VIDEO_TITLE.MAX_LENGTH);
}
