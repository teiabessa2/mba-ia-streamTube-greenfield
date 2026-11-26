import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { useTestBucket } from '../src/test/test-bucket';
import { Video } from '../src/videos/entities/video.entity';
import { createVideosE2eApp, registerAndLogin } from './support/videos-e2e';

interface InitiateUploadBody {
  id: string;
  public_id: string;
  status: string;
  part_size: number;
  part_count: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('videos-initiate-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let restoreBucket: () => void;
  let accessToken: string;
  let userId: string;
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
    ({ userId, accessToken } = await registerAndLogin(
      app,
      'uploader@example.com',
    ));
  });

  const countVideos = () => dataSource.getRepository(Video).count();

  const initiate = (body: Record<string, unknown>, token = accessToken) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Keeps track of created drafts so their open multipart uploads get aborted. */
  async function trackDraft(id: string): Promise<Video> {
    const video = await dataSource.getRepository(Video).findOneByOrFail({ id });
    openUploads.push({ key: video.storage_key, uploadId: video.upload_id! });
    return video;
  }

  // 1. Iniciar upload e pré-cadastrar rascunho

  it('inicia-upload-cria-rascunho-com-multipart-aberto', async () => {
    const res = await initiate({
      file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 134217728,
    });

    expect(res.status).toBe(201);
    const body = res.body as InitiateUploadBody;
    expect(body.id).toMatch(UUID_RE);
    expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body).toMatchObject({
      status: 'draft',
      part_size: 67108864,
      part_count: 2,
    });

    const video = await trackDraft(body.id);
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: userId });
    expect(video.status).toBe('draft');
    expect(video.channel_id).toBe(channel.id);
    expect(video.storage_key).toBe(`videos/${body.id}/original`);
    expect(video.upload_id).not.toBeNull();

    await expect(
      storageService.listParts(video.storage_key, video.upload_id!),
    ).resolves.toEqual([]);
  });

  it('aceita-extensao-e-mime-em-maiusculas', async () => {
    const res = await initiate({
      file_name: 'CLIP.MOV',
      content_type: 'video/quicktime',
      size_bytes: 1048576,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft', part_count: 1 });
    await trackDraft((res.body as InitiateUploadBody).id);
  });

  // 2. Rejeitar arquivo fora das regras sem criar rascunho

  it('rejeita-tamanho-acima-de-10gb', async () => {
    const before = await countVideos();

    const tooLarge = await initiate({
      file_name: 'big.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418241,
    });

    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({
      statusCode: 413,
      error: 'VIDEO_TOO_LARGE',
      message: expect.any(String) as string,
    });
    expect(await countVideos()).toBe(before);

    const atLimit = await initiate({
      file_name: 'big.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418240,
    });

    expect(atLimit.status).toBe(201);
    await trackDraft((atLimit.body as InitiateUploadBody).id);
  });

  it('rejeita-formato-fora-da-allowlist', async () => {
    const before = await countVideos();

    const wrongMime = await initiate({
      file_name: 'clip.mp4',
      content_type: 'image/png',
      size_bytes: 1048576,
    });

    expect(wrongMime.status).toBe(415);
    expect(wrongMime.body).toMatchObject({ error: 'UNSUPPORTED_VIDEO_FORMAT' });
    expect(await countVideos()).toBe(before);

    const wrongExtension = await initiate({
      file_name: 'clip.avi',
      content_type: 'video/mp4',
      size_bytes: 1048576,
    });

    expect(wrongExtension.status).toBe(415);
    expect(wrongExtension.body).toMatchObject({
      error: 'UNSUPPORTED_VIDEO_FORMAT',
    });
    expect(await countVideos()).toBe(before);
  });

  it('rejeita-corpo-fora-do-schema', async () => {
    const before = await countVideos();

    const res = await initiate({
      file_name: 'clip.mp4',
      content_type: 'video/mp4',
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(await countVideos()).toBe(before);
  });

  // 3. Exigir autenticação

  it('rejeita-requisicao-sem-token', async () => {
    const before = await countVideos();

    const res = await request(app.getHttpServer()).post('/videos').send({
      file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
    });

    expect(res.status).toBe(401);
    expect(await countVideos()).toBe(before);
  });
});
