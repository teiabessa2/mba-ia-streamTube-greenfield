import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { requestPresigned } from '../test/presigned-http';
import { StorageInvalidPartsError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/** Dedicated bucket so tests never touch dev objects (phase-03-videos/TD-13). */
const TEST_BUCKET = 'streamtube-test';
/** S3 minimum size for every part except the last one. */
const MIN_PART_SIZE = 5 * 1024 * 1024;

const hostOf = (url: string) => new URL(url).host;

describe('StorageService (MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let warnSpy: jest.SpyInstance;
  let originalBucket: string | undefined;
  const createdKeys: string[] = [];

  const newKey = () => {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  const putPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ) => {
    const url = await storage.presignUploadPart(key, uploadId, partNumber);
    return requestPresigned(url, { method: 'PUT', body });
  };

  beforeAll(async () => {
    originalBucket = process.env.S3_BUCKET;
    process.env.S3_BUCKET = TEST_BUCKET;
    warnSpy = jest.spyOn(Logger.prototype, 'warn');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init(); // runs ensureBucket()
    storage = moduleRef.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await moduleRef.close();
    process.env.S3_BUCKET = originalBucket;
    warnSpy.mockRestore();
  });

  describe('boot (ensureBucket)', () => {
    it('should leave a private bucket that rejects anonymous GET with 403', async () => {
      const res = await fetch(`${process.env.S3_ENDPOINT}/${TEST_BUCKET}/`);
      expect(res.status).toBe(403);
    });

    it('should warn naming the MINIO_API_CORS_ALLOW_ORIGIN fallback when PutBucketCors is NotImplemented', () => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MINIO_API_CORS_ALLOW_ORIGIN'),
      );
    });

    it('should be idempotent when the bucket already exists', async () => {
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
    });
  });

  describe('multipart upload', () => {
    it('should upload 2 parts via presigned URLs, list them and complete the object', async () => {
      const key = newKey();
      const part1 = Buffer.alloc(MIN_PART_SIZE, 'a');
      const part2 = Buffer.from('last-part');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const res1 = await putPart(key, uploadId, 1, part1);
      const res2 = await putPart(key, uploadId, 2, part2);

      expect(res1.statusCode).toBe(200);
      expect(res1.headers.etag).toEqual(expect.any(String));
      expect(res2.statusCode).toBe(200);

      const parts = await storage.listParts(key, uploadId);
      expect(parts).toEqual([
        { partNumber: 1, etag: res1.headers.etag, sizeBytes: part1.length },
        { partNumber: 2, etag: res2.headers.etag, sizeBytes: part2.length },
      ]);

      // Out of order on purpose: the service sorts by part number.
      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 2, etag: res2.headers.etag as string },
        { partNumber: 1, etag: res1.headers.etag as string },
      ]);

      await expect(storage.headObjectSize(key)).resolves.toBe(
        part1.length + part2.length,
      );
    }, 30_000);

    it('should throw StorageInvalidPartsError on a wrong ETag and keep the upload resumable', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await putPart(key, uploadId, 1, Buffer.from('only-part'));

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(StorageInvalidPartsError);

      await expect(storage.listParts(key, uploadId)).resolves.toHaveLength(1);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should discard the parts on abort so listParts fails with NoSuchUpload', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await putPart(key, uploadId, 1, Buffer.from('to-be-discarded'));

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
        name: 'NoSuchUpload',
      });
    });

    it('should resolve a repeated abort: MinIO answers 204 for an upload that no longer exists', async () => {
      // AWS S3 answers NoSuchUpload here instead; that mapping is unit-tested.
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });
  });

  describe('putObject / deleteObject', () => {
    it('should store an object and remove it', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.from('thumb'), 'image/jpeg');
      await expect(storage.headObjectSize(key)).resolves.toBe(5);

      await storage.deleteObject(key);

      await expect(storage.headObjectSize(key)).rejects.toMatchObject({
        name: 'NotFound',
      });
    });
  });

  describe('presigned URLs', () => {
    it('should sign presignUploadPart and presignGet for the S3_PUBLIC_ENDPOINT host', async () => {
      const publicHost = hostOf(process.env.S3_PUBLIC_ENDPOINT as string);

      const partUrl = await storage.presignUploadPart('k', 'upload-id', 1);
      const getUrl = await storage.presignGet('k', { expiresIn: 60 });

      expect(hostOf(partUrl)).toBe(publicHost);
      expect(hostOf(getUrl)).toBe(publicHost);
      expect(new URL(partUrl).searchParams.get('X-Amz-Expires')).toBe('3600');
    });

    it('should sign presignInternalGet for the S3_ENDPOINT host with 900s expiry', async () => {
      const url = await storage.presignInternalGet('k');

      expect(hostOf(url)).toBe(hostOf(process.env.S3_ENDPOINT as string));
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
    });

    it('should serve a public presigned GET (via requestPresigned) with the response header overrides', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.from('payload'), 'video/mp4');
      const url = await storage.presignGet(key, {
        expiresIn: 60,
        contentDisposition: 'attachment; filename="video.mp4"',
      });

      const res = await requestPresigned(url, { method: 'GET' });

      expect(res.statusCode).toBe(200);
      expect(res.body.toString()).toBe('payload');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="video.mp4"',
      );
    });
  });
});
