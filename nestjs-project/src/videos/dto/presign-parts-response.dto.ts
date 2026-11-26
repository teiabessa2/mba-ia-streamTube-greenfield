import { ApiProperty } from '@nestjs/swagger';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  /** Presigned PUT URL for this part. */
  @ApiProperty({ format: 'uri' })
  url: string;
}

export class PresignPartsResponseDto {
  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  /** Lifetime of every returned URL, in seconds. */
  @ApiProperty({ example: 3600 })
  expires_in: number;
}
