import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { UploadIntentDto } from './dto/upload-intent.dto';
import {
  ConfirmUploadResult,
  UploadIntentResult,
  VideoDetailResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload-intent')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers a video as a draft owned by the caller's channel and starts an S3 multipart upload session, returning presigned URLs for each part.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload intent created',
    schema: {
      properties: {
        video: {
          properties: {
            id: { type: 'string', format: 'uuid' },
            slug: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', example: 'draft' },
          },
        },
        uploadId: { type: 'string' },
        partUrls: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async uploadIntent(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadIntentDto,
  ): Promise<UploadIntentResult> {
    return this.videosService.createUploadIntent(user.sub, dto);
  }

  @Post(':slug/confirm-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Confirm a video upload',
    description:
      "Completes the S3 multipart upload session and enqueues asynchronous processing. Only the video's owning channel may confirm it, and only while it is still in draft status.",
  })
  @ApiResponse({
    status: 200,
    description: 'Upload confirmed; processing started',
    schema: {
      properties: {
        status: { type: 'string', example: 'uploaded' },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async confirmUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: ConfirmUploadDto,
  ): Promise<ConfirmUploadResult> {
    return this.videosService.confirmUpload(user.sub, slug, dto);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug')
  @ApiOperation({
    summary: 'Get video details',
    description:
      "Public when the video is ready; while not ready, only the owning channel's authenticated caller may see it — every other caller (including anonymous) gets 404, indistinguishable from a nonexistent slug.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        status: { type: 'string', example: 'ready' },
        duration: { type: 'number', nullable: true },
        metadata: { type: 'object', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        channel: {
          properties: {
            id: { type: 'string', format: 'uuid' },
            nickname: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not ready and caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findBySlug(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('slug') slug: string,
  ): Promise<VideoDetailResult> {
    return this.videosService.findBySlug(slug, user?.sub);
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL for the video file. The API never proxies the bytes; the client follows the redirect and streams directly from storage, which supports Range requests natively.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to a presigned GET URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getStreamRedirectUrl(slug);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL for the video file, with a Content-Disposition override that forces the browser to download it as an attachment.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to a presigned GET URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getDownloadRedirectUrl(slug);
    res.redirect(HttpStatus.FOUND, url);
  }
}
