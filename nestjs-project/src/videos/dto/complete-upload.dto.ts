import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_UPLOAD_LIMITS } from '../videos.constants';

export class CompleteUploadPartDto {
  /** Part number, as sent to its presigned URL. */
  @IsInt()
  @Min(1)
  @Max(VIDEO_UPLOAD_LIMITS.MAX_PART_NUMBER)
  part_number: number;

  /** ETag returned by the storage for the part PUT. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part (1 to 10000 items, part_number without repetition). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD_LIMITS.MAX_PART_NUMBER)
  @ArrayUnique(
    (part: Partial<CompleteUploadPartDto> | null) => part?.part_number,
  )
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadPartDto)
  parts: CompleteUploadPartDto[];
}
