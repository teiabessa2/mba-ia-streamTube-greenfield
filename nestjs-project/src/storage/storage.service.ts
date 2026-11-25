import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  INVALID_PARTS_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
  STORAGE_BOOT,
  STORAGE_DEFAULTS,
} from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from './storage.errors';
import type {
  CompletedPart,
  PresignGetOptions,
  PutObjectBody,
  UploadedPart,
} from './storage.types';

interface S3ErrorLike {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const asS3Error = (err: unknown): S3ErrorLike =>
  typeof err === 'object' && err !== null ? (err as S3ErrorLike) : {};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single entry point to the object storage. All real traffic goes through the
 * internal client (Compose service name); the public client only signs URLs
 * handed to HTTP consumers outside the Compose network (phase-03-videos/TD-02).
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  /**
   * Waits for the storage to answer, creates the private bucket if missing and
   * tries per-bucket CORS. MinIO answers `NotImplemented` to `PutBucketCors`;
   * there CORS comes from `MINIO_API_CORS_ALLOW_ORIGIN` (Compose).
   */
  async ensureBucket(): Promise<void> {
    const bucket = this.config.bucket;
    const exists = await this.waitForBucketHead(bucket);
    if (!exists) {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      this.logger.log(`Bucket "${bucket}" created`);
    }

    try {
      await this.internalClient.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'PUT'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
              },
            ],
          },
        }),
      );
    } catch (err) {
      if (asS3Error(err).name !== 'NotImplemented') throw err;
      this.logger.warn(
        `PutBucketCors is not implemented by the storage; relying on the server-wide MINIO_API_CORS_ALLOW_ORIGIN fallback for bucket "${bucket}"`,
      );
    }
  }

  /** Returns whether the bucket exists, retrying while the storage does not answer. */
  private async waitForBucketHead(bucket: string): Promise<boolean> {
    const deadline = Date.now() + STORAGE_BOOT.RETRY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.internalClient.send(
          new HeadBucketCommand({ Bucket: bucket }),
        );
        return true;
      } catch (err) {
        const { name, message, $metadata } = asS3Error(err);
        const status = $metadata?.httpStatusCode;
        if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
          return false;
        }
        // No HTTP status → connection error; 503 → server still initializing.
        const unreachable = status === undefined || status === 503;
        if (!unreachable) throw err;
        if (Date.now() >= deadline) {
          throw new Error(
            `Object storage at ${this.config.endpoint} did not respond within ${STORAGE_BOOT.RETRY_TIMEOUT_MS}ms: ${message ?? name ?? 'unknown error'}`,
          );
        }
        this.logger.warn(
          `Object storage not ready (${message ?? name}); retrying in ${STORAGE_BOOT.RETRY_INTERVAL_MS}ms`,
        );
        await sleep(STORAGE_BOOT.RETRY_INTERVAL_MS);
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error(`Storage returned no UploadId for key "${key}"`);
    }
    return res.UploadId;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of res.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          sizeBytes: part.Size ?? 0,
        });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  /** Completes the upload; parts are sorted by part number as S3 requires. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (err) {
      const { name, message } = asS3Error(err);
      if (name && INVALID_PARTS_ERROR_NAMES.includes(name)) {
        throw new StorageInvalidPartsError(name, message ?? name);
      }
      throw err;
    }
  }

  /** Discards the uploaded parts; `NoSuchUpload` → `StorageUploadNotFoundError`. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      const { name, message } = asS3Error(err);
      if (name === 'NoSuchUpload') {
        throw new StorageUploadNotFoundError(message ?? name);
      }
      throw err;
    }
  }

  async headObjectSize(key: string): Promise<number> {
    const res = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return res.ContentLength ?? 0;
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async putObject(
    key: string,
    body: PutObjectBody,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Presigned PUT for one part, signed for the public endpoint. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = STORAGE_DEFAULTS.UPLOAD_PART_EXPIRES_IN_S,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  /** Presigned GET for HTTP consumers (stream/download), signed for the public endpoint. */
  async presignGet(key: string, options: PresignGetOptions): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  /** Presigned GET read inside the Compose network (ffprobe/ffmpeg in the worker). */
  async presignInternalGet(
    key: string,
    expiresIn: number = STORAGE_DEFAULTS.INTERNAL_GET_EXPIRES_IN_S,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
  }
}
