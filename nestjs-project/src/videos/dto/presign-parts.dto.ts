import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD_LIMITS } from '../videos.constants';

export class PresignPartsDto {
  /** Part numbers to sign (1 to 100 distinct items, each ≤ the video part_count). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD_LIMITS.MAX_PARTS_PER_PRESIGN)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
