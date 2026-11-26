/** Any http(s) URL, up to whitespace or the `: ` that ffmpeg puts after its input. */
const URL_PATTERN = /https?:\/\/\S+?(?=:\s|\s|$)/g;

/**
 * `failure_reason` is shown to the video owner (`GET /videos/:id`). ffprobe /
 * ffmpeg echo their input in stderr, which here is a presigned URL carrying
 * the internal host, the bucket and a valid signature: never persist or log it.
 */
export function toFailureReason(message: string): string {
  return message.replace(URL_PATTERN, '<source>');
}
