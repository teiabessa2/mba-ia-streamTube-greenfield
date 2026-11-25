import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/presigned-http';
import { useTestBucket } from '../src/test/test-bucket';
import { Video } from '../src/videos/entities/video.entity';
import {
  createVideosE2eApp,
  registerAndLogin,
  type AuthenticatedUser,
} from './support/videos-e2e';

interface PresignBody {
  parts: { part_number: number; url: string }[];
  expires_in: number;
}

const PART_SIZE = 67108864;

describe('videos-upload-parts', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let restoreBucket: () => void;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let videoId: string;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    app = await createVideosE2eApp();
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60_000);

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storageService.abortMultipartUpload(key, uploadId);
    }
    await app.close();
    restoreBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, 'owner@example.com');
    other = await registerAndLogin(app, 'other@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: PART_SIZE + 1, // part_count = 2
      })
      .expect(201);
    videoId = (res.body as { id: string }).id;

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    openUploads.push({ key: video.storage_key, uploadId: video.upload_id! });
  });

  const presign = (
    id: string,
    partNumbers: unknown,
    token = owner.accessToken,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });

  const listParts = (id: string, token = owner.accessToken) =>
    request(app.getHttpServer())
      .get(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);

  /** Sends one 64 MiB part through its presigned URL and returns the ETag. */
  async function putFirstPart(): Promise<string> {
    const res = await presign(videoId, [1]).expect(200);
    const [{ url }] = (res.body as PresignBody).parts;
    const put = await requestPresigned(url, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 'a'),
    });
    expect(put.statusCode).toBe(200);
    return put.headers.etag as string;
  }

  // 1. Gerar URLs de parte e enviar ao storage

  it('gera-urls-ordenadas-no-host-publico', async () => {
    const res = await presign(videoId, [2, 1]);

    expect(res.status).toBe(200);
    const body = res.body as PresignBody;
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
    const publicHost = new URL(process.env.S3_PUBLIC_ENDPOINT as string).host;
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }
    expect(body.expires_in).toBe(3600);
  });

  it('put-de-parte-aceito-pelo-storage', async () => {
    const res = await presign(videoId, [1]);
    expect(res.status).toBe(200);
    const [{ url }] = (res.body as PresignBody).parts;

    const put = await requestPresigned(url, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 'a'),
    });

    expect(put.statusCode).toBe(200);
    expect(put.headers.etag).toEqual(expect.stringMatching(/.+/));
  }, 30_000);

  it('rejeita-numero-de-parte-acima-do-part-count', async () => {
    const res = await presign(videoId, [3]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
  });

  it('rejeita-lote-vazio-ou-acima-de-100', async () => {
    const empty = await presign(videoId, []);
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    const tooMany = await presign(
      videoId,
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  // 2. Listar partes recebidas para retomar o upload

  it('lista-somente-a-parte-enviada', async () => {
    const etag = await putFirstPart();

    const res = await listParts(videoId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      parts: [{ part_number: 1, etag, size_bytes: PART_SIZE }],
      part_size: PART_SIZE,
      part_count: 2,
    });
  }, 30_000);

  // 3. Restringir ao dono e ao status draft

  it('outro-usuario-recebe-404-nas-duas-rotas', async () => {
    const post = await presign(videoId, [1], other.accessToken);
    expect(post.status).toBe(404);
    expect(post.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });

    const get = await listParts(videoId, other.accessToken);
    expect(get.status).toBe(404);
    expect(get.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });

  it('video-fora-de-draft-recebe-409-nas-duas-rotas', async () => {
    await dataSource.query(
      `UPDATE videos SET status = 'processing' WHERE id = $1`,
      [videoId],
    );

    const post = await presign(videoId, [1]);
    expect(post.status).toBe(409);
    expect(post.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });

    const get = await listParts(videoId);
    expect(get.status).toBe(409);
    expect(get.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });
  });

  it('id-nao-uuid-recebe-400', async () => {
    const post = await presign('not-a-uuid', [1]);
    expect(post.status).toBe(400);
    expect(post.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    const get = await listParts('not-a-uuid');
    expect(get.status).toBe(400);
    expect(get.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
