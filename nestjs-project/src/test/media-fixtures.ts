import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoFixtureOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

/**
 * Generates short media files with the FFmpeg of the dev image, in a temporary
 * directory, so no video binary is committed (phase-03-videos/TD-13).
 */
export class MediaFixtures {
  private constructor(readonly dir: string) {}

  static async create(): Promise<MediaFixtures> {
    return new MediaFixtures(await mkdtemp(join(tmpdir(), 'media-fixtures-')));
  }

  /** H.264 MP4 from `testsrc`, with an AAC `sine` track unless `withAudio: false`. */
  async video(
    name: string,
    {
      durationSeconds = 3,
      width = 320,
      height = 240,
      withAudio = true,
    }: VideoFixtureOptions = {},
  ): Promise<string> {
    const output = join(this.dir, name);
    const video = `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`;
    const args = ['-v', 'error', '-f', 'lavfi', '-i', video];
    if (withAudio) {
      args.push(
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=1000:duration=${durationSeconds}`,
      );
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (withAudio) args.push('-c:a', 'aac', '-shortest');
    args.push('-movflags', '+faststart', '-y', output);

    await execFileAsync('ffmpeg', args);
    return output;
  }

  /** A small JPEG (one `testsrc` frame), e.g. a thumbnail stored directly. */
  async jpeg(name: string): Promise<string> {
    const output = join(this.dir, name);
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120',
      '-frames:v',
      '1',
      '-y',
      output,
    ]);
    return output;
  }

  /** A plain text file with a video extension (not decodable as media). */
  async fakeVideo(name: string): Promise<string> {
    const output = join(this.dir, name);
    await writeFile(output, 'this is not a video\n');
    return output;
  }

  /** Path inside the fixtures directory for files the test writes. */
  path(name: string): string {
    return join(this.dir, name);
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
