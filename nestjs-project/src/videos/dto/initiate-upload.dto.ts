import { IsInt, IsString, Length, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Original file name; its extension must be in the allowlist. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** Declared MIME type; must be in the allowlist. */
  @IsString()
  content_type: string;

  /** Declared size in bytes (max 10737418240). */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
