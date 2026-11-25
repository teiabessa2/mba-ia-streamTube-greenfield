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
