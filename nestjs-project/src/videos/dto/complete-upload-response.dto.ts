import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.types';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Xk3_9aQpL0w' })
  public_id: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING],
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus.PROCESSING;
}
