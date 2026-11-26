import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MediaFixtures } from '../src/test/media-fixtures';
import { requestPresigned } from '../src/test/presigned-http';
import { useTestBucket } from '../src/test/test-bucket';
import { Video } from '../src/videos/entities/video.entity';
import { videoStorageKeys } from '../src/videos/videos.constants';
import { VideoStatus, type VideoMetadata } from '../src/videos/videos.types';
import {
  createVideosE2eApp,
  registerAndLogin,
  type AuthenticatedUser,
} from './support/videos-e2e';

const METADATA: VideoMetadata = {
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: 'aac',
  bitrate: 121714,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 45643,
};
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const withoutMessage = (body: unknown): Record<string, unknown> => {
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.message;
  return copy;
};

describe('videos-get-owned', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let fixtures: MediaFixtures;
  let jpeg: Buffer;
  let restoreBucket: () => void;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let videoId: string;
  const thumbnailKeys: string[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    fixtures = await MediaFixtures.create();
    jpeg = await readFile(await fixtures.jpeg('thumbnail.jpg'));
    app = await createVideosE2eApp();
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await fixtures.cleanup();
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
        size_bytes: 45643,
      })
      .expect(201);
    videoId = (created.body as { id: string }).id;
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
    for (const key of thumbnailKeys.splice(0)) {
      await storageService.deleteObject(key);
    }
  });

  const getVideo = (id: string, token: string | null = owner.accessToken) => {
    const req = request(app.getHttpServer()).get(`/videos/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  /** Moves the draft straight to a final state in the DB (the worker is SI-03.14). */
  const moveTo = (fields: Partial<Video>) =>
    dataSource.getRepository(Video).update({ id: videoId }, fields);

  // 1. Consultar o próprio vídeo em cada status

  it('rascunho-sem-metadados', async () => {
    const res = await getVideo(videoId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: videoId,
      status: 'draft',
      duration_seconds: null,
      metadata: null,
      thumbnail_url: null,
      failure_reason: null,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 45643,
    });
    const body = res.body as Record<string, string>;
    expect(typeof body.public_id).toBe('string');
    expect(body.created_at).toMatch(ISO_8601);
    expect(body.updated_at).toMatch(ISO_8601);
  });

  it('video-ready-com-metadados-e-thumbnail', async () => {
    const thumbnailKey = videoStorageKeys.thumbnail(videoId);
    thumbnailKeys.push(thumbnailKey);
    await storageService.putObject(thumbnailKey, jpeg, 'image/jpeg');
    await moveTo({
      status: VideoStatus.READY,
      duration_seconds: 3.0,
      metadata: METADATA,
      thumbnail_key: thumbnailKey,
    });

    const res = await getVideo(videoId);

    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      duration_seconds: unknown;
      metadata: VideoMetadata;
      thumbnail_url: string;
    };
    expect(body.status).toBe('ready');
    expect(body.duration_seconds).toBe(3);
    expect(body.metadata).toEqual(METADATA);
    expect(new URL(body.thumbnail_url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );

    const thumbnail = await requestPresigned(body.thumbnail_url, {
      method: 'GET',
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('video-failed-com-motivo', async () => {
    await moveTo({
      status: VideoStatus.FAILED,
      failure_reason: 'ffprobe: no video stream',
    });

    const res = await getVideo(videoId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'failed',
      failure_reason: 'ffprobe: no video stream',
    });
  });

  // 2. Restringir ao dono autenticado

  it('outro-usuario-recebe-404', async () => {
    const foreign = await getVideo(videoId, other.accessToken);
    const missing = await getVideo(randomUUID());

    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect(missing.status).toBe(404);
    // Same envelope for "not yours" and "does not exist" (message may vary).
    expect(withoutMessage(missing.body)).toEqual(withoutMessage(foreign.body));
  });

  it('sem-token-recebe-401', async () => {
    const res = await getVideo(videoId, null);

    expect(res.status).toBe(401);
  });

  it('id-nao-uuid-recebe-400', async () => {
    const res = await getVideo('not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
