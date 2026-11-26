import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/presigned-http';
import { useTestBucket } from '../src/test/test-bucket';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.types';
import {
  createVideosE2eApp,
  registerAndLogin,
  type AuthenticatedUser,
} from './support/videos-e2e';

const FILE_NAME = 'my clip.mp4';
const CONTENT_TYPE = 'video/mp4';
const SIZE_BYTES = 4096;
const NOT_READY = [
  VideoStatus.DRAFT,
  VideoStatus.PROCESSING,
  VideoStatus.FAILED,
] as const;

describe('videos-playback', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let restoreBucket: () => void;
  let owner: AuthenticatedUser;
  const objectKeys: string[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    app = await createVideosE2eApp();
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    restoreBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, 'owner@example.com');
  }, 30_000);

  afterEach(async () => {
    const open = await dataSource
      .getRepository(Video)
      .findBy({ upload_id: Not(IsNull()) });
    for (const video of open) {
      await storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
    }
    for (const key of objectKeys.splice(0)) {
      await storageService.deleteObject(key);
    }
  });

  /** `POST /videos` as the owner; returns the persisted draft row. */
  const createDraft = async (): Promise<Video> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: FILE_NAME,
        content_type: CONTENT_TYPE,
        size_bytes: SIZE_BYTES,
      })
      .expect(201);
    return dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: (res.body as { id: string }).id });
  };

  /** Moves a draft straight to `status` in the DB (the worker is SI-03.14). */
  const moveTo = (video: Video, status: VideoStatus) =>
    dataSource.getRepository(Video).update({ id: video.id }, { status });

  const getPlayback = (
    publicId: string,
    mode: 'stream' | 'download',
    token: string | null = null,
  ) => {
    const req = request(app.getHttpServer())
      .get(`/videos/${publicId}/${mode}`)
      .redirects(0);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const publicHost = () =>
    new URL(process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000').host;

  // 1. Reproduzir e baixar um vídeo pronto

  describe('ready video', () => {
    let video: Video;
    let content: Buffer;

    beforeEach(async () => {
      video = await createDraft();
      // The bytes are written directly; the multipart of the draft is discarded.
      await storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
      content = randomBytes(SIZE_BYTES);
      await storageService.putObject(video.storage_key, content, CONTENT_TYPE);
      objectKeys.push(video.storage_key);
      await dataSource
        .getRepository(Video)
        .update(
          { id: video.id },
          { status: VideoStatus.READY, upload_id: null },
        );
    });

    it('stream-redireciona-para-url-publica', async () => {
      const res = await getPlayback(video.public_id, 'stream');

      expect(res.status).toBe(302);
      expect(res.body).toEqual({});
      const location = new URL(res.headers.location);
      expect(location.host).toBe(publicHost());
      expect(location.searchParams.get('X-Amz-Signature')).toEqual(
        expect.any(String),
      );
    });

    it('stream-atende-range-com-206', async () => {
      const res = await getPlayback(video.public_id, 'stream');
      expect(res.status).toBe(302);

      const media = await requestPresigned(res.headers.location, {
        method: 'GET',
        headers: { Range: 'bytes=0-99' },
      });

      expect(media.statusCode).toBe(206);
      expect(media.body.length).toBe(100);
      expect(media.body.equals(content.subarray(0, 100))).toBe(true);
      expect(media.headers['content-range']).toBe(`bytes 0-99/${SIZE_BYTES}`);
      expect(media.headers['content-type']).toBe(CONTENT_TYPE);
    });

    it('download-forca-attachment-com-nome-original', async () => {
      const res = await getPlayback(video.public_id, 'download');

      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).host).toBe(publicHost());

      const media = await requestPresigned(res.headers.location, {
        method: 'GET',
      });

      expect(media.statusCode).toBe(200);
      expect(media.body.equals(content)).toBe(true);
      expect(media.headers['content-disposition']).toBe(
        `attachment; filename="${FILE_NAME}"`,
      );
    });
  });

  // 2. Esconder vídeos que não estão prontos

  describe('video not ready', () => {
    const videos = new Map<VideoStatus, Video>();

    beforeEach(async () => {
      for (const status of NOT_READY) {
        const video = await createDraft();
        if (status !== VideoStatus.DRAFT) await moveTo(video, status);
        videos.set(status, video);
      }
    });

    it('status-nao-ready-recebe-404-inclusive-para-o-dono', async () => {
      for (const status of NOT_READY) {
        const { public_id } = videos.get(status)!;
        for (const mode of ['stream', 'download'] as const) {
          for (const token of [null, owner.accessToken]) {
            const res = await getPlayback(public_id, mode, token);

            expect({ status, mode, owner: !!token, code: res.status }).toEqual({
              status,
              mode,
              owner: !!token,
              code: 404,
            });
            expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
          }
        }
      }
    });

    it('public-id-inexistente-tem-resposta-identica', async () => {
      const processing = await getPlayback(
        videos.get(VideoStatus.PROCESSING)!.public_id,
        'stream',
      );

      const unknown = await getPlayback('AAAAAAAAAAA', 'stream');

      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
      const pick = (body: unknown) => {
        const { statusCode, error, message } = body as Record<string, unknown>;
        return { statusCode, error, message };
      };
      expect(pick(unknown.body)).toEqual(pick(processing.body));

      const malformed = await getPlayback('x', 'stream');

      expect(malformed.status).toBe(404);
      expect(malformed.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });
  });
});
