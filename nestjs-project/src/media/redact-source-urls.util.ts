/** Any http(s) URL, up to whitespace or the `: ` that ffmpeg puts after its input. */
const URL_PATTERN = /https?:\/\/\S+?(?=:\s|\s|$)/g;

/**
 * ffprobe / ffmpeg echo their input in stderr and in the failed command line,
 * which here is a presigned URL carrying the internal host, the bucket and a
 * valid signature: never let it reach an error message, a log or the
 * owner-facing `failure_reason` (`GET /videos/:id`).
 */
export function redactSourceUrls(message: string): string {
  return message.replace(URL_PATTERN, '<source>');
}
