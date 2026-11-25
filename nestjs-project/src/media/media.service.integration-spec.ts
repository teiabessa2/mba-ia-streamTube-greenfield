import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { MediaFixtures } from '../test/media-fixtures';
import { useTestBucket } from '../test/test-bucket';
import { MEDIA_OPTIONS } from './media.constants';
import { InvalidMediaError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

describe('MediaService (FFmpeg + MinIO)', () => {
  let moduleRef: TestingModule;
  let media: MediaService;
  let storage: StorageService;
  let fixtures: MediaFixtures;
  let restoreBucket: () => void;
  const createdKeys: string[] = [];

  /** Uploads a local file to the test bucket and returns an internal presigned GET. */
  const serve = async (path: string): Promise<string> => {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    await storage.putObject(key, await readFile(path), 'video/mp4');
    return storage.presignInternalGet(key);
  };

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    fixtures = await MediaFixtures.create();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    await moduleRef.init(); // ensureBucket()
    media = moduleRef.get(MediaService);
    storage = moduleRef.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await moduleRef.close();
    await fixtures.cleanup();
    restoreBucket();
  });

  describe('probe', () => {
    it('should read duration and metadata of a 3s 320x240 MP4 with audio over HTTP', async () => {
      const url = await serve(await fixtures.video('with-audio.mp4'));

      const result = await media.probe(url);

      expect(result.durationSeconds).toBeGreaterThanOrEqual(2.9);
      expect(result.durationSeconds).toBeLessThanOrEqual(3.1);
      const { bitrate, formatName, sizeBytes, ...stream } = result.metadata;
      expect(stream).toEqual({
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
      expect(formatName).toContain('mp4');
      expect(bitrate).toBeGreaterThan(0);
      expect(sizeBytes).toBeGreaterThan(0);
    }, 30_000);

    it('should omit audioCodec for a video without an audio track', async () => {
      const url = await serve(
        await fixtures.video('no-audio.mp4', { withAudio: false }),
      );

      const result = await media.probe(url);

      expect(result.metadata.videoCodec).toBe('h264');
      expect(result.metadata).not.toHaveProperty('audioCodec');
    }, 30_000);

    it('should throw InvalidMediaError for a text file renamed to .mp4', async () => {
      const url = await serve(await fixtures.fakeVideo('fake.mp4'));

      await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
    }, 30_000);

    it('should throw a transient error (not InvalidMediaError) when the object is unreachable', async () => {
      const url = await storage.presignInternalGet(
        `test/${randomUUID()}/missing`,
      );

      const error = await media.probe(url).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
    }, 30_000);
  });

  describe('probe timeout', () => {
    let hangingServer: Server;
    let timeoutModule: TestingModule;

    beforeAll(async () => {
      // Accepts the connection and never answers, so ffprobe blocks until killed.
      hangingServer = createServer(() => undefined);
      await new Promise<void>((resolve) =>
        hangingServer.listen(0, '127.0.0.1', resolve),
      );
      timeoutModule = await Test.createTestingModule({
        imports: [MediaModule],
      })
        .overrideProvider(MEDIA_OPTIONS)
        .useValue({ probeTimeoutMs: 500, frameTimeoutMs: 500 })
        .compile();
    });

    afterAll(async () => {
      hangingServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        hangingServer.close(() => resolve()),
      );
      await timeoutModule.close();
    });

    it('should throw an error that is not InvalidMediaError when ffprobe exceeds the timeout', async () => {
      const { port } = hangingServer.address() as AddressInfo;
      const service = timeoutModule.get(MediaService);

      const error = await service
        .probe(`http://127.0.0.1:${port}/video.mp4`)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toMatch(/timed out/);
    }, 15_000);
  });

  describe('extractFrame', () => {
    it('should write a non-empty JPEG read from an HTTP URL', async () => {
      const url = await serve(await fixtures.video('frame-source.mp4'));
      const outputPath = fixtures.path('thumbnail.jpg');

      await media.extractFrame(url, 1, outputPath);

      const jpeg = await readFile(outputPath);
      expect(jpeg.length).toBeGreaterThan(0);
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }, 30_000);
  });
});
