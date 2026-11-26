import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  type HttpRedirectResponse,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';
import type { PlaybackMode } from './videos.types';

const PUBLIC_ID_PARAM = {
  name: 'publicId',
  description: 'Public video id (11 base64url characters)',
  example: 'dQw4w9WgXcQ',
} as const;

/** 302 with the presigned `Location` + the uniform 404 of the playback routes. */
const ApiPlaybackResponses = (location: string) =>
  applyDecorators(
    ApiResponse({
      status: 302,
      description: `Redirect to ${location}`,
      headers: {
        Location: {
          description: `${location} (valid for 3600s)`,
          schema: { type: 'string', format: 'uri' },
        },
      },
    }),
    ApiResponse({
      status: 404,
      description:
        'Unknown or malformed publicId, or video not ready: draft, processing or failed (VIDEO_NOT_FOUND)',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
  );

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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
  @ApiBearerAuth('access-token')
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

  @Delete(':id/upload')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload of a draft owned by the caller, discarding the parts already sent to the storage, and deletes the draft.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft deleted' })
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
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get an owned video',
    description:
      'Returns the status (draft, processing, ready or failed) and the details of a video owned by the caller: extracted duration and metadata, failure reason and a presigned thumbnail URL (valid for 3600s).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiOkResponse({ description: 'Video detail', type: VideoResponseDto })
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
  async getOwned(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedDetail(user.sub, id);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Public. Redirects (302) to a presigned GET URL of the original file of a ready video. The storage serves Range requests (206), so players can seek without downloading the whole file. No bytes go through the API.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiPlaybackResponses('the presigned stream URL')
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<HttpRedirectResponse> {
    return this.redirectToPlayback(publicId, 'stream');
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Public. Redirects (302) to a presigned GET URL of the original file of a ready video, answered with Content-Disposition: attachment and the original file name.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiPlaybackResponses('the presigned download URL')
  async download(
    @Param('publicId') publicId: string,
  ): Promise<HttpRedirectResponse> {
    return this.redirectToPlayback(publicId, 'download');
  }

  private async redirectToPlayback(
    publicId: string,
    mode: PlaybackMode,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getPlaybackUrl(publicId, mode);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
