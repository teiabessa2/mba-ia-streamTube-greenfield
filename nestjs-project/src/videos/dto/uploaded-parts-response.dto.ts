import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];

  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 2 })
  part_count: number;
}
