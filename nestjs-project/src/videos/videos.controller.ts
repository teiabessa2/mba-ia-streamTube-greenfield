import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Validates the declared file, creates a draft video in the caller channel and opens a multipart upload in the object storage. The video bytes are sent directly to the storage through presigned part URLs.',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size above 10737418240 bytes (VIDEO_TOO_LARGE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description:
      'Content type or file extension outside the allowlist (UNSUPPORTED_VIDEO_FORMAT)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns presigned PUT URLs (valid for 3600s) for the requested parts of a draft owned by the caller, in ascending part order. Also used to renew expired URLs.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiBody({ type: PresignPartsDto })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PresignPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or a part number above part_count (INVALID_PART_NUMBER)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft (VIDEO_NOT_IN_DRAFT)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    return this.videosService.presignParts(user.sub, id, dto.part_numbers);
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts the storage already received for a draft owned by the caller, so an interrupted upload can be resumed.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 200,
    description: 'Parts received so far, in ascending part order',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft (VIDEO_NOT_IN_DRAFT)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload of a draft owned by the caller, checks the real object size against size_bytes, moves the video to processing and queues the process-video job. Repeating the call does not queue the job again.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR), parts rejected by the storage (INVALID_UPLOAD_PARTS; the draft is kept) or real size different from size_bytes (UPLOAD_SIZE_MISMATCH; object and draft are deleted)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'Video is no longer in draft, e.g. a repeated complete (VIDEO_NOT_IN_DRAFT)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }
}
