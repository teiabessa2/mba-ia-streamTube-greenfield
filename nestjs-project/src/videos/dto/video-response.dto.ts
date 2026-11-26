import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Video } from '../entities/video.entity';
import { VideoStatus } from '../videos.types';

/** Metadata extracted by ffprobe; keys are the internal ones, verbatim. */
export class VideoMetadataDto {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  videoCodec: string;

  @ApiPropertyOptional({
    example: 'aac',
    description: 'Absent when the video has no audio track',
  })
  audioCodec?: string;

  @ApiProperty({ example: 4500000, description: 'Bits per second' })
  bitrate: number;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  formatName: string;

  @ApiProperty({ example: 134217728 })
  sizeBytes: number;
}

/** Owner view of a video in any status (`GET /videos/:id`). */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Xk3_9aQpL0w' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'Minhas férias' })
  title: string;

  @ApiProperty({ example: 'clip.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 134217728 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 63.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Presigned GET URL of the thumbnail (valid for 3600s); null until processed',
  })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;

  static from(video: Video, thumbnailUrl: string | null): VideoResponseDto {
    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      title: video.title,
      original_filename: video.original_filename,
      content_type: video.content_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: thumbnailUrl,
      failure_reason: video.failure_reason,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }
}
