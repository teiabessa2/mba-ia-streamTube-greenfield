import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not } from 'typeorm';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/presigned-http';
import { useTestBucket } from '../src/test/test-bucket';
import { useTestQueuePrefix } from '../src/test/test-queue';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.types';
import {
  createVideosE2eApp,
  registerAndLogin,
  type AuthenticatedUser,
} from './support/videos-e2e';

interface UploadedDraft {
  id: string;
  publicId: string;
  etag: string;
}

const UPLOADED_BYTES = 1024;

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let restoreBucket: () => void;
  let testPrefix: ReturnType<typeof useTestQueuePrefix>;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  const storageKeys: string[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    testPrefix = useTestQueuePrefix('e2e-complete');
    app = await createVideosE2eApp();
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
    // No worker runs in this suite: jobs stay in the queue to be inspected.
    queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEOS));
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
    restoreBucket();
    testPrefix.restore();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, 'owner@example.com');
    other = await registerAndLogin(app, 'other@example.com');
  });

  afterEach(async () => {
    // Drafts still open in the storage are aborted; completed objects deleted.
    const drafts = await dataSource
      .getRepository(Video)
      .findBy({ upload_id: Not(IsNull()) });
    for (const draft of drafts) {
      await storageService.abortMultipartUpload(
        draft.storage_key,
        draft.upload_id!,
      );
    }
    for (const key of storageKeys.splice(0)) {
      await storageService.deleteObject(key);
    }
  });

  /** Creates a 1-part draft and PUTs 1024 bytes to its presigned part URL. */
  async function createUploadedDraft(
    sizeBytes = UPLOADED_BYTES,
  ): Promise<UploadedDraft> {
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    const { id, public_id: publicId } = created.body as {
      id: string;
      public_id: string;
    };
    storageKeys.push(`videos/${id}/original`);

    const presigned = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const [{ url }] = (presigned.body as { parts: { url: string }[] }).parts;
    const put = await requestPresigned(url, {
      method: 'PUT',
      body: Buffer.alloc(UPLOADED_BYTES, 'v'),
    });
    expect(put.statusCode).toBe(200);
    return { id, publicId, etag: put.headers.etag as string };
  }

  const complete = (id: string, parts: unknown, token = owner.accessToken) =>
    request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });

  const findVideo = (id: string) =>
    dataSource.getRepository(Video).findOneBy({ id });

  const jobsFor = async (videoId: string) =>
    (await queue.getJobs(['waiting', 'delayed', 'active'])).filter(
      (job) => (job.data as { videoId?: string })?.videoId === videoId,
    );

  // 1. Concluir upload e enfileirar processamento

  it('conclui-e-passa-para-processing', async () => {
    const draft = await createUploadedDraft();

    const res = await complete(draft.id, [
      { part_number: 1, etag: draft.etag },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: draft.id,
      public_id: draft.publicId,
      status: 'processing',
    });
    const video = await findVideo(draft.id);
    expect(video?.status).toBe(VideoStatus.PROCESSING);
    expect(video?.upload_id).toBeNull();
    const job = await queue.getJob(draft.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: draft.id });
  });

  it('complete-repetido-nao-reenfileira', async () => {
    const draft = await createUploadedDraft();
    const parts = [{ part_number: 1, etag: draft.etag }];

    await complete(draft.id, parts).expect(200);
    const repeated = await complete(draft.id, parts);

    expect(repeated.status).toBe(409);
    expect(repeated.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });
    expect(await jobsFor(draft.id)).toHaveLength(1);
  });

  // 2. Rejeitar conclusões inválidas

  it('etag-errado-mantem-rascunho-retomavel', async () => {
    const draft = await createUploadedDraft();
    const before = await findVideo(draft.id);

    const res = await complete(draft.id, [
      { part_number: 1, etag: '"00000000000000000000000000000000"' },
    ]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_UPLOAD_PARTS' });
    const after = await findVideo(draft.id);
    expect(after?.status).toBe(VideoStatus.DRAFT);
    expect(after?.upload_id).toBe(before?.upload_id);
    const listed = await request(app.getHttpServer())
      .get(`/videos/${draft.id}/upload/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      parts: [{ part_number: 1, etag: draft.etag }],
    });
  });

  it('tamanho-real-divergente-apaga-rascunho-e-objeto', async () => {
    const draft = await createUploadedDraft(2 * UPLOADED_BYTES);

    const res = await complete(draft.id, [
      { part_number: 1, etag: draft.etag },
    ]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'UPLOAD_SIZE_MISMATCH' });
    expect(await findVideo(draft.id)).toBeNull();
    await expect(
      storageService.headObjectSize(`videos/${draft.id}/original`),
    ).rejects.toMatchObject({ name: 'NotFound' });
    expect(await queue.getJob(draft.id)).toBeUndefined();
  });

  it('part-number-repetido-recebe-400', async () => {
    const draft = await createUploadedDraft();

    const res = await complete(draft.id, [
      { part_number: 1, etag: draft.etag },
      { part_number: 1, etag: draft.etag },
    ]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect((await findVideo(draft.id))?.status).toBe(VideoStatus.DRAFT);
  });

  // 3. Restringir ao dono

  it('outro-usuario-recebe-404', async () => {
    const draft = await createUploadedDraft();

    const res = await complete(
      draft.id,
      [{ part_number: 1, etag: draft.etag }],
      other.accessToken,
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect((await findVideo(draft.id))?.status).toBe(VideoStatus.DRAFT);
    expect(await queue.getJob(draft.id)).toBeUndefined();
  });
});
