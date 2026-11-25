import { DomainException } from '../common/exceptions/domain.exception';
import { VIDEO_UPLOAD_LIMITS } from './videos.constants';

export class VideoTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_TOO_LARGE',
      413,
      `Video exceeds the maximum size of ${VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES} bytes`,
    );
  }
}

export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      415,
      'Video format is not supported (accepted: mp4, mov, webm, mkv)',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotInDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_IN_DRAFT', 409, 'Video upload is no longer in draft');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_PART_NUMBER',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'The uploaded parts are invalid or incomplete',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      400,
      'Uploaded file size does not match the declared size',
    );
  }
}
