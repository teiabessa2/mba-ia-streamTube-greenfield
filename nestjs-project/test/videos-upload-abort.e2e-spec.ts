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

const PART_SIZE = 67108864;

describe('videos-upload-abort', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let restoreBucket: () => void;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let videoId: string;
  let storageKey: string;
  let uploadId: string;

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
    other = await registerAndLogin(app, 'other@example.com');

    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: PART_SIZE + 1, // part_count = 2
      })
      .expect(201);
    videoId = (created.body as { id: string }).id;

    const presigned = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const [{ url }] = (presigned.body as { parts: { url: string }[] }).parts;
    const put = await requestPresigned(url, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 'a'),
    });
    expect(put.statusCode).toBe(200);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    storageKey = video.storage_key;
    uploadId = video.upload_id!;
  }, 30_000);

  afterEach(async () => {
    // Uploads left open by the rejected scenarios (incl. the one moved to
    // processing directly in the DB, which keeps its upload_id) are discarded.
    const open = await dataSource
      .getRepository(Video)
      .findBy({ upload_id: Not(IsNull()) });
    for (const video of open) {
      await storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
    }
  });

  const abort = (id: string, token = owner.accessToken) =>
    request(app.getHttpServer())
      .delete(`/videos/${id}/upload`)
      .set('Authorization', `Bearer ${token}`);

  const findVideo = (id: string) =>
    dataSource.getRepository(Video).findOneBy({ id });

  // 1. Abortar upload do próprio rascunho

  it('abort-remove-rascunho-e-partes', async () => {
    const res = await abort(videoId);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await findVideo(videoId)).toBeNull();
    await expect(
      storageService.listParts(storageKey, uploadId),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('abort-repetido-recebe-404', async () => {
    await abort(videoId).expect(204);

    const repeated = await abort(videoId);

    expect(repeated.status).toBe(404);
    expect(repeated.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });

  // 2. Recusar abort fora das regras

  it('video-em-processing-recebe-409', async () => {
    await dataSource.query(
      `UPDATE videos SET status = 'processing' WHERE id = $1`,
      [videoId],
    );
    const before = await findVideo(videoId);

    const res = await abort(videoId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });
    const after = await findVideo(videoId);
    expect(after).toEqual(before);
    expect(after?.status).toBe(VideoStatus.PROCESSING);
  });

  it('outro-usuario-recebe-404', async () => {
    const res = await abort(videoId, other.accessToken);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect((await findVideo(videoId))?.status).toBe(VideoStatus.DRAFT);
  });
});
