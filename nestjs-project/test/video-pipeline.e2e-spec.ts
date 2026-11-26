import { readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MediaFixtures } from '../src/test/media-fixtures';
import { requestPresigned } from '../src/test/presigned-http';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_UPLOAD_LIMITS } from '../src/videos/videos.constants';
import { registerAndLogin, type AuthenticatedUser } from './support/videos-e2e';
import {
  createVideoPipeline,
  getDownload,
  getStream,
  putPart,
  type VideoPipeline,
} from './support/video-pipeline';

const PART_SIZE = VIDEO_UPLOAD_LIMITS.PART_SIZE_BYTES;
const MIB = 1024 * 1024;
const CONTENT_TYPE = 'video/mp4';
/** Generous ceiling for a JSON body; any video part is at least 64 MiB. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
const FLOW_TIMEOUT_MS = 90_000;

interface InitiatedUpload {
  id: string;
  public_id: string;
  part_count: number;
}

interface VideoDetail {
  status: string;
  public_id: string;
  duration_seconds: number | null;
  metadata: Record<string, unknown> | null;
  thumbnail_url: string | null;
  failure_reason: string | null;
}

describe('video-pipeline (API + worker)', () => {
  let pipeline: VideoPipeline;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let fixtures: MediaFixtures;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    fixtures = await MediaFixtures.create();
    pipeline = await createVideoPipeline('video-pipeline');
    app = pipeline.app;
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60_000);

  afterAll(async () => {
    await pipeline.close();
    await fixtures.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerAndLogin(app, 'owner@example.com');
  }, 30_000);

  afterEach(async () => {
    for (const video of await dataSource.getRepository(Video).find()) {
      if (video.upload_id) {
        await storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      await storageService.deleteObject(video.storage_key);
      if (video.thumbnail_key) {
        await storageService.deleteObject(video.thumbnail_key);
      }
    }
  });

  // ---- API calls (JSON only) ----

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${owner.accessToken}`);

  const initiate = async (
    fileName: string,
    sizeBytes: number,
  ): Promise<InitiatedUpload> => {
    const res = await authed(request(app.getHttpServer()).post('/videos'))
      .send({
        file_name: fileName,
        content_type: CONTENT_TYPE,
        size_bytes: sizeBytes,
      })
      .expect(201);
    return res.body as InitiatedUpload;
  };

  const presign = async (
    id: string,
    partNumbers: number[],
  ): Promise<Map<number, string>> => {
    const res = await authed(
      request(app.getHttpServer()).post(`/videos/${id}/upload/parts`),
    )
      .send({ part_numbers: partNumbers })
      .expect(200);
    const { parts } = res.body as {
      parts: { part_number: number; url: string }[];
    };
    return new Map(parts.map((p) => [p.part_number, p.url]));
  };

  const complete = (
    id: string,
    parts: { part_number: number; etag: string }[],
  ) =>
    authed(request(app.getHttpServer()).post(`/videos/${id}/upload/complete`))
      .send({ parts })
      .expect(200);

  const getDetail = async (id: string): Promise<VideoDetail> => {
    const res = await authed(
      request(app.getHttpServer()).get(`/videos/${id}`),
    ).expect(200);
    return res.body as VideoDetail;
  };

  const getPlayback = (publicId: string, mode: 'stream' | 'download') =>
    request(app.getHttpServer())
      .get(`/videos/${publicId}/${mode}`)
      .redirects(0);

  /** `onFailed` writes the row after the QueueEvents notice: wait for it. */
  const waitForStatus = async (
    id: string,
    status: string,
  ): Promise<VideoDetail> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const detail = await getDetail(id);
      if (detail.status === status || Date.now() > deadline) return detail;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** Splits `content` in parts of `part_size` bytes (part 1 = first chunk). */
  const chunkOf = (content: Buffer, partNumber: number) =>
    content.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);

  /** Whole flow for one video: initiate → PUT every part → complete → job. */
  const uploadAndProcess = async (fileName: string, content: Buffer) => {
    const upload = await initiate(fileName, content.length);
    const numbers = Array.from({ length: upload.part_count }, (_, i) => i + 1);
    const urls = await presign(upload.id, numbers);
    const parts: { part_number: number; etag: string }[] = [];
    for (const n of numbers) {
      parts.push({
        part_number: n,
        etag: await putPart(urls.get(n)!, chunkOf(content, n)),
      });
    }
    const finished = pipeline.waitForJob(upload.id);
    await complete(upload.id, parts);
    return { upload, outcome: await finished };
  };

  const expectStreamOf = async (publicId: string, content: Buffer) => {
    const redirect = await getPlayback(publicId, 'stream');
    expect(redirect.status).toBe(302);

    const media = await getStream(redirect.headers.location, 'bytes=0-99');

    expect(media.statusCode).toBe(206);
    expect(media.body.equals(content.subarray(0, 100))).toBe(true);
    expect(media.headers['content-range']).toBe(`bytes 0-99/${content.length}`);
    return redirect.headers.location;
  };

  // ---- Scenarios ----

  it(
    'mp4-em-2-partes-chega-a-ready-e-e-reproduzido',
    async () => {
      const content = await readFile(
        await fixtures.video('happy.mp4', { padToBytes: PART_SIZE + MIB }),
      );
      pipeline.apiRequests.reset();

      const { upload, outcome } = await uploadAndProcess('happy.mp4', content);

      expect(upload.part_count).toBe(2);
      expect(outcome).toEqual({ state: 'completed' });

      const detail = await getDetail(upload.id);
      expect(detail.status).toBe('ready');
      expect(detail.duration_seconds).toBeCloseTo(3, 1);
      expect(detail.metadata).toMatchObject({
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: 'aac',
        sizeBytes: content.length,
      });
      expect(detail.failure_reason).toBeNull();
      const thumbnail = await requestPresigned(detail.thumbnail_url!, {
        method: 'GET',
      });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/jpeg');
      expect(thumbnail.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

      await expectStreamOf(upload.public_id, content);

      const redirect = await getPlayback(upload.public_id, 'download');
      expect(redirect.status).toBe(302);
      const download = await getDownload(redirect.headers.location);
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-disposition']).toBe(
        'attachment; filename="happy.mp4"',
      );
      expect(download.body.equals(content)).toBe(true);

      // No API request carried video bytes: every body was small JSON.
      expect(pipeline.apiRequests.list.length).toBeGreaterThan(0);
      for (const req of pipeline.apiRequests.list) {
        expect(req.contentType ?? `none (${req.method} ${req.url})`).toMatch(
          /^application\/json/,
        );
        expect(req.contentLength).toBeLessThan(MAX_JSON_BODY_BYTES);
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'upload-interrompido-e-retomado-sem-reenviar-a-parte-1',
    async () => {
      const content = await readFile(
        await fixtures.video('resumed.mp4', {
          durationSeconds: 4,
          padToBytes: PART_SIZE + 2 * MIB,
        }),
      );
      const upload = await initiate('resumed.mp4', content.length);
      expect(upload.part_count).toBe(2);
      const sentParts: number[] = [];

      // First session: only part 1 is sent, then the upload is interrupted.
      const firstUrls = await presign(upload.id, [1]);
      const etag1 = await putPart(firstUrls.get(1)!, chunkOf(content, 1));
      sentParts.push(1);

      // Resume: ask the API what the storage already has.
      const listed = await authed(
        request(app.getHttpServer()).get(`/videos/${upload.id}/upload/parts`),
      ).expect(200);
      const { parts: uploaded } = listed.body as {
        parts: { part_number: number; etag: string; size_bytes: number }[];
      };
      expect(uploaded).toEqual([
        { part_number: 1, etag: etag1, size_bytes: PART_SIZE },
      ]);

      const missing = [1, 2].filter(
        (n) => !uploaded.some((p) => p.part_number === n),
      );
      expect(missing).toEqual([2]);
      const resumeUrls = await presign(upload.id, missing);
      const etag2 = await putPart(resumeUrls.get(2)!, chunkOf(content, 2));
      sentParts.push(2);

      const finished = pipeline.waitForJob(upload.id);
      await complete(upload.id, [
        ...uploaded.map(({ part_number, etag }) => ({ part_number, etag })),
        { part_number: 2, etag: etag2 },
      ]);

      expect(sentParts).toEqual([1, 2]);
      expect(await finished).toEqual({ state: 'completed' });
      const detail = await getDetail(upload.id);
      expect(detail.status).toBe('ready');
      expect(detail.duration_seconds).toBeCloseTo(4, 1);
      await expectStreamOf(upload.public_id, content);
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'arquivo-que-nao-e-video-termina-failed',
    async () => {
      const content = await readFile(
        await fixtures.fakeVideo('not-a-video.mp4'),
      );

      const { upload, outcome } = await uploadAndProcess(
        'not-a-video.mp4',
        content,
      );

      expect(outcome.state).toBe('failed');
      const detail = await waitForStatus(upload.id, 'failed');
      expect(detail.status).toBe('failed');
      expect(detail.failure_reason).toEqual(expect.any(String));
      expect(detail.failure_reason!.length).toBeGreaterThan(0);
      expect(detail.duration_seconds).toBeNull();
      expect(detail.thumbnail_url).toBeNull();
      const stream = await getPlayback(upload.public_id, 'stream');
      expect(stream.status).toBe(404);
      expect(stream.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'dois-videos-tem-public-id-distintos-e-cada-stream-aponta-para-o-proprio-objeto',
    async () => {
      const first = await readFile(
        await fixtures.video('first.mp4', { durationSeconds: 2 }),
      );
      const second = await readFile(
        await fixtures.video('second.mp4', { durationSeconds: 5 }),
      );
      expect(first.length).not.toBe(second.length);

      const a = await uploadAndProcess('first.mp4', first);
      const b = await uploadAndProcess('second.mp4', second);

      expect(a.outcome).toEqual({ state: 'completed' });
      expect(b.outcome).toEqual({ state: 'completed' });
      expect(a.upload.public_id).not.toBe(b.upload.public_id);
      const locationA = await expectStreamOf(a.upload.public_id, first);
      const locationB = await expectStreamOf(b.upload.public_id, second);
      expect(new URL(locationA).pathname).toContain(
        `/videos/${a.upload.id}/original`,
      );
      expect(new URL(locationB).pathname).toContain(
        `/videos/${b.upload.id}/original`,
      );
    },
    FLOW_TIMEOUT_MS,
  );
});
