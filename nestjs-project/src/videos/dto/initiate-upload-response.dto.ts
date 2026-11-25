import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.types';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Xk3_9aQpL0w' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 2 })
  part_count: number;
}
