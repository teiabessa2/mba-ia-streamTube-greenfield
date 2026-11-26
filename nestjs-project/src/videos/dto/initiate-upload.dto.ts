import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { VIDEO_TITLE } from '../videos.constants';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InitiateUploadDto {
  /**
   * Video title, trimmed before validation (1–100 characters). Defaults to
   * the file name without its extension.
   */
  @ApiPropertyOptional({
    minLength: VIDEO_TITLE.MIN_LENGTH,
    maxLength: VIDEO_TITLE.MAX_LENGTH,
    example: 'Minhas férias',
    description:
      'Trimmed before validation. When absent: file_name without its last extension, trimmed (the trimmed file_name if that is empty), capped at 100 characters',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(VIDEO_TITLE.MIN_LENGTH, VIDEO_TITLE.MAX_LENGTH)
  title?: string;

  /** Original file name; its extension must be in the allowlist. */
  @ApiProperty({ minLength: 1, maxLength: 255, example: 'clip.mp4' })
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** Declared MIME type; must be in the allowlist. */
  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  content_type: string;

  /** Declared size in bytes (max 10737418240). */
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 10737418240,
    example: 134217728,
  })
  @IsInt()
  @Min(1)
  size_bytes: number;
}
