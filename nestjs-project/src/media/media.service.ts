import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import {
  INVALID_MEDIA_STDERR_PATTERNS,
  MEDIA_DEFAULTS,
  MEDIA_OPTIONS,
} from './media.constants';
import { InvalidMediaError } from './media.errors';
import type { MediaOptions, ProbeResult } from './media.types';
import { redactSourceUrls } from './redact-source-urls.util';

const execFileAsync = promisify(execFile);

/** Error rejected by the promisified `execFile` (exit code, timeout kill, output). */
interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

/**
 * Thin wrapper over the ffprobe/ffmpeg binaries (phase-03-videos/TD-05). Both
 * read the source through a presigned HTTP URL with range requests, never a
 * full download (TD-06).
 */
@Injectable()
export class MediaService {
  constructor(@Inject(MEDIA_OPTIONS) private readonly options: MediaOptions) {}

  /**
   * Reads duration and technical metadata. Throws `InvalidMediaError` when the
   * source is not a readable video; timeouts and network/storage failures
   * throw a plain (transient) error.
   */
  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.runProbe(url);
    const output = this.parseProbeOutput(stdout);

    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    if (!video?.codec_name || !video.width || !video.height) {
      throw new InvalidMediaError('No video stream found in the file');
    }
    const audio = streams.find((stream) => stream.codec_type === 'audio');

    const durationSeconds = Number(output.format?.duration);
    const sizeBytes = Number(output.format?.size);
    if (!(durationSeconds > 0) || !(sizeBytes > 0)) {
      throw new InvalidMediaError('The file has no readable duration or size');
    }
    const declaredBitrate = Number(output.format?.bit_rate);
    const bitrate =
      declaredBitrate > 0
        ? declaredBitrate
        : Math.round((sizeBytes * 8) / durationSeconds);

    return {
      durationSeconds,
      metadata: {
        width: video.width,
        height: video.height,
        videoCodec: video.codec_name,
        ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
        bitrate,
        formatName: output.format?.format_name ?? 'unknown',
        sizeBytes,
      },
    };
  }

  /** Writes one JPEG frame taken at `atSeconds` (input seek, HTTP range read). */
  async extractFrame(
    url: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(atSeconds),
          '-i',
          url,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-y',
          outputPath,
        ],
        { timeout: this.options.frameTimeoutMs },
      );
    } catch (error) {
      // A new Error: the execFile one also carries the URL in `cmd`/`stderr`/`stack`.
      throw new Error(redactSourceUrls((error as Error).message));
    }

    // ffmpeg exits 0 with an empty output when the seek lands past the end.
    const { size } = await stat(outputPath);
    if (size === 0) {
      throw new Error(`ffmpeg wrote an empty frame at ${atSeconds}s`);
    }
  }

  private async runProbe(url: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          url,
        ],
        {
          timeout: this.options.probeTimeoutMs,
          maxBuffer: MEDIA_DEFAULTS.PROBE_MAX_BUFFER_BYTES,
        },
      );
      return stdout;
    } catch (error) {
      throw this.translateProbeError(error as ExecFileError);
    }
  }

  private translateProbeError(error: ExecFileError): Error {
    if (error.killed || error.signal) {
      return new Error(
        `ffprobe timed out after ${this.options.probeTimeoutMs}ms`,
      );
    }
    const stderr = error.stderr ?? '';
    if (
      typeof error.code === 'number' &&
      INVALID_MEDIA_STDERR_PATTERNS.some((pattern) => pattern.test(stderr))
    ) {
      return new InvalidMediaError(
        `ffprobe could not read the file: ${redactSourceUrls(stderr.trim())}`,
      );
    }
    return new Error(
      `ffprobe failed: ${redactSourceUrls(stderr.trim() || error.message)}`,
    );
  }

  private parseProbeOutput(stdout: string): FfprobeOutput {
    try {
      return JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new InvalidMediaError('ffprobe output is not readable JSON');
    }
  }
}
