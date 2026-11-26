import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
  STORAGE_BOOT,
} from './storage.constants';
import { StorageUploadNotFoundError } from './storage.errors';
import { StorageService } from './storage.service';

const s3Error = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(name), {
    name,
    $metadata: httpStatusCode === undefined ? {} : { httpStatusCode },
  });

const connectionRefused = () =>
  Object.assign(new Error('connect ECONNREFUSED 172.18.0.5:9000'), {
    code: 'ECONNREFUSED',
    $metadata: {},
  });

describe('StorageService.ensureBucket', () => {
  let service: StorageService;
  let send: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    send = jest.fn();
    const client = { send, destroy: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_INTERNAL_CLIENT, useValue: client },
        { provide: S3_PUBLIC_CLIENT, useValue: { send: jest.fn() } },
        {
          provide: storageConfig.KEY,
          useValue: { bucket: 'bucket', endpoint: 'http://minio:9000' },
        },
      ],
    }).compile();
    service = moduleRef.get(StorageService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const sentCommands = () =>
    send.mock.calls.map(([command]) => (command as object).constructor);

  it('should retry HeadBucket on connection errors and succeed once the storage answers', async () => {
    jest.useFakeTimers();
    send
      .mockRejectedValueOnce(connectionRefused())
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce({}) // HeadBucket
      .mockResolvedValueOnce({}); // PutBucketCors

    const promise = service.ensureBucket();
    await jest.advanceTimersByTimeAsync(STORAGE_BOOT.RETRY_INTERVAL_MS * 2);
    await promise;

    expect(sentCommands()).toEqual([
      HeadBucketCommand,
      HeadBucketCommand,
      HeadBucketCommand,
      PutBucketCorsCommand,
    ]);
  });

  it('should retry while the storage answers 503 (still initializing)', async () => {
    jest.useFakeTimers();
    send
      .mockRejectedValueOnce(s3Error('XMinioServerNotInitialized', 503))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const promise = service.ensureBucket();
    await jest.advanceTimersByTimeAsync(STORAGE_BOOT.RETRY_INTERVAL_MS);
    await promise;

    expect(sentCommands()[1]).toBe(HeadBucketCommand);
  });

  it('should fail the boot with a clear error once the retry window is exhausted', async () => {
    jest.useFakeTimers();
    send.mockRejectedValue(connectionRefused());

    const promise = service.ensureBucket();
    const assertion = expect(promise).rejects.toThrow(
      /Object storage at http:\/\/minio:9000 did not respond within 30000ms: connect ECONNREFUSED/,
    );
    await jest.advanceTimersByTimeAsync(
      STORAGE_BOOT.RETRY_TIMEOUT_MS + STORAGE_BOOT.RETRY_INTERVAL_MS,
    );
    await assertion;
    expect(sentCommands()).not.toContain(CreateBucketCommand);
  });

  it('should create the bucket when HeadBucket answers NotFound', async () => {
    send
      .mockRejectedValueOnce(s3Error('NotFound', 404))
      .mockResolvedValueOnce({}) // CreateBucket
      .mockResolvedValueOnce({}); // PutBucketCors

    await service.ensureBucket();

    expect(sentCommands()).toEqual([
      HeadBucketCommand,
      CreateBucketCommand,
      PutBucketCorsCommand,
    ]);
    const [, , [cors]] = send.mock.calls as [PutBucketCorsCommand][];
    expect(cors.input.CORSConfiguration?.CORSRules?.[0]).toMatchObject({
      AllowedMethods: ['GET', 'PUT'],
      ExposeHeaders: ['ETag'],
    });
  });

  it('should not retry or create on other HeadBucket errors (e.g. 403)', async () => {
    send.mockRejectedValueOnce(s3Error('Forbidden', 403));

    await expect(service.ensureBucket()).rejects.toThrow('Forbidden');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('should warn and keep booting when PutBucketCors answers NotImplemented', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(s3Error('NotImplemented', 501));

    await expect(service.ensureBucket()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('MINIO_API_CORS_ALLOW_ORIGIN'),
    );
  });

  it('should fail the boot when PutBucketCors answers AccessDenied', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(s3Error('AccessDenied', 403));

    await expect(service.ensureBucket()).rejects.toThrow('AccessDenied');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('MINIO_API_CORS_ALLOW_ORIGIN'),
    );
  });
});

describe('StorageService.abortMultipartUpload', () => {
  let service: StorageService;
  let send: jest.Mock;

  beforeEach(async () => {
    send = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_INTERNAL_CLIENT, useValue: { send } },
        { provide: S3_PUBLIC_CLIENT, useValue: { send: jest.fn() } },
        { provide: storageConfig.KEY, useValue: { bucket: 'bucket' } },
      ],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  it('should send AbortMultipartUpload for the key and upload id', async () => {
    send.mockResolvedValueOnce({});

    await service.abortMultipartUpload('videos/v/original', 'upload-id');

    const [[command]] = send.mock.calls as [AbortMultipartUploadCommand][];
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: 'bucket',
      Key: 'videos/v/original',
      UploadId: 'upload-id',
    });
  });

  it('should map NoSuchUpload (AWS S3 for an unknown upload) to StorageUploadNotFoundError', async () => {
    send.mockRejectedValueOnce(s3Error('NoSuchUpload', 404));

    await expect(
      service.abortMultipartUpload('videos/v/original', 'upload-id'),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('should propagate other errors unchanged', async () => {
    const denied = s3Error('AccessDenied', 403);
    send.mockRejectedValueOnce(denied);

    await expect(
      service.abortMultipartUpload('videos/v/original', 'upload-id'),
    ).rejects.toBe(denied);
  });
});
