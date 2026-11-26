/**
 * The storage rejected the parts of a multipart upload (`InvalidPart`,
 * `InvalidPartOrder`, `NoSuchUpload`). Storage-level error: the videos
 * domain translates it to `INVALID_UPLOAD_PARTS`.
 */
export class StorageInvalidPartsError extends Error {
  constructor(
    readonly storageErrorName: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageInvalidPartsError';
  }
}

/**
 * The multipart upload no longer exists in the storage (`NoSuchUpload`):
 * already aborted, completed or expired.
 */
export class StorageUploadNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUploadNotFoundError';
  }
}
