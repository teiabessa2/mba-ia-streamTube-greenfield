import type { PutObjectCommandInput } from '@aws-sdk/client-s3';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface PresignGetOptions {
  expiresIn: number;
  /** Overrides the response `Content-Type`. */
  contentType?: string;
  /** Overrides the response `Content-Disposition` (e.g. `attachment; filename="..."`). */
  contentDisposition?: string;
}

export type PutObjectBody = NonNullable<PutObjectCommandInput['Body']>;
