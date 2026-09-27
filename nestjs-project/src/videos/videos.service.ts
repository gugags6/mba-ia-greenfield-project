import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnauthorizedVideoAccessException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { UploadIntentDto } from './dto/upload-intent.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MULTIPART_PART_SIZE_BYTES,
  VIDEO_SLUG_LENGTH,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_RETRIES = 5;

export interface UploadIntentResult {
  video: { id: string; slug: string; title: string; status: VideoStatus };
  uploadId: string;
  partUrls: { partNumber: number; url: string }[];
}

export interface ConfirmUploadResult {
  status: string;
  message: string;
}

export interface VideoDetailResult {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: VideoStatus;
  duration: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  channel: { id: string; nickname: string };
}

/** Strips characters that would break out of the Content-Disposition header value. */
function sanitizeFilename(title: string): string {
  return title.replace(/["\r\n]/g, '').slice(0, 200) || 'video';
}

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async createUploadIntent(
    userId: string,
    dto: UploadIntentDto,
  ): Promise<UploadIntentResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.saveWithUniqueSlug({
      channel_id: channel.id,
      title: dto.title,
      description: dto.description ?? null,
      status: VideoStatus.DRAFT,
    });

    const key = `videos/${video.id}/original`;
    const uploadId = await this.storageService.createMultipartUpload(
      this.storage.videosBucket,
      key,
      dto.mimeType,
    );

    const partCount = Math.max(
      1,
      Math.ceil(dto.sizeBytes / MULTIPART_PART_SIZE_BYTES),
    );
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, index) =>
        this.storageService
          .getPresignedPartUrl(
            this.storage.videosBucket,
            key,
            uploadId,
            index + 1,
          )
          .then((url) => ({ partNumber: index + 1, url })),
      ),
    );

    video.video_storage_key = key;
    video.multipart_upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      video: {
        id: video.id,
        slug: video.slug,
        title: video.title,
        status: video.status,
      },
      uploadId,
      partUrls,
    };
  }

  async confirmUpload(
    userId: string,
    slug: string,
    dto: ConfirmUploadDto,
  ): Promise<ConfirmUploadResult> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new UnauthorizedVideoAccessException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }

    if (!video.video_storage_key || !video.multipart_upload_id) {
      throw new Error(
        'Video is missing multipart upload state required to confirm the upload',
      );
    }

    await this.storageService.completeMultipartUpload(
      this.storage.videosBucket,
      video.video_storage_key,
      video.multipart_upload_id,
      dto.parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.eTag,
      })),
    );

    video.status = VideoStatus.UPLOADED;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add('process-video', {
      videoId: video.id,
      channelId: video.channel_id,
      videoStorageKey: video.video_storage_key,
    });

    return {
      status: 'uploaded',
      message: 'Upload confirmed; processing started',
    };
  }

  async findBySlug(slug: string, userId?: string): Promise<VideoDetailResult> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = userId ? await this.isOwnedByUser(video, userId) : false;
    if (video.status !== VideoStatus.READY && !isOwner) {
      // Enumeration-resistant: non-owner (or anonymous) gets the same 404
      // whether the slug doesn't exist or the video simply isn't ready yet.
      throw new VideoNotFoundException();
    }

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      description: video.description,
      status: video.status,
      duration: video.duration,
      metadata: video.metadata,
      createdAt: video.created_at,
      channel: { id: video.channel.id, nickname: video.channel.nickname },
    };
  }

  private async isOwnedByUser(video: Video, userId: string): Promise<boolean> {
    const channel = await this.channelsService.findByUserId(userId);
    return !!channel && channel.id === video.channel_id;
  }

  async getStreamRedirectUrl(slug: string): Promise<string> {
    const video = await this.findReadyBySlug(slug);
    return this.storageService.getPresignedGetUrl(
      this.storage.videosBucket,
      video.video_storage_key!,
    );
  }

  async getDownloadRedirectUrl(slug: string): Promise<string> {
    const video = await this.findReadyBySlug(slug);
    return this.storageService.getPresignedGetUrl(
      this.storage.videosBucket,
      video.video_storage_key!,
      {
        responseContentDisposition: `attachment; filename="${sanitizeFilename(video.title)}.mp4"`,
      },
    );
  }

  private async findReadyBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findById(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOne({ where: { id: videoId } });
  }

  async markProcessing(
    videoId: string,
    result: { duration: number; metadata: Record<string, unknown> },
  ): Promise<void> {
    const video = await this.videoRepository.findOneOrFail({
      where: { id: videoId },
    });
    video.status = VideoStatus.PROCESSING;
    video.duration = result.duration;
    video.metadata = result.metadata;
    await this.videoRepository.save(video);
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    const video = await this.videoRepository.findOneOrFail({
      where: { id: videoId },
    });
    video.status = VideoStatus.FAILED;
    video.error_reason = reason;
    await this.videoRepository.save(video);
  }

  async markReady(videoId: string, thumbnailStorageKey: string): Promise<void> {
    const video = await this.videoRepository.findOneOrFail({
      where: { id: videoId },
    });
    video.status = VideoStatus.READY;
    video.thumbnail_storage_key = thumbnailStorageKey;
    await this.videoRepository.save(video);
  }

  private async saveWithUniqueSlug(
    fields: Pick<Video, 'channel_id' | 'title' | 'description' | 'status'>,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      const slug = nanoid(VIDEO_SLUG_LENGTH);
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug }),
        );
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
          throw err;
        }
        // Collision on the nanoid slug — retry with a freshly generated one.
      }
    }
    throw new Error('Slug conflict could not be resolved after max retries');
  }
}
