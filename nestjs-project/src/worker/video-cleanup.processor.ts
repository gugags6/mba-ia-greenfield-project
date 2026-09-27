import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { VIDEO_CLEANUP_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

export interface CleanupAbandonedVideosJobData {
  olderThanHours: number;
}

@Processor(VIDEO_CLEANUP_QUEUE)
export class VideoCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoCleanupProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<CleanupAbandonedVideosJobData>): Promise<void> {
    const olderThanHours = job.data.olderThanHours;
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

    const expiredDrafts = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    for (const video of expiredDrafts) {
      if (video.multipart_upload_id && video.video_storage_key) {
        await this.abortMultipartUploadIfPresent(
          video.video_storage_key,
          video.multipart_upload_id,
          video.id,
        );
      }
      await this.videoRepository.remove(video);
      this.logger.log(`Removed abandoned draft video ${video.id}`);
    }
  }

  /**
   * Aborting an already-aborted (or never-started) multipart session is a
   * no-op per phase-03-videos/TD-11 — a retried job (at-least-once delivery)
   * must not fail forever because the session is already gone.
   */
  private async abortMultipartUploadIfPresent(
    videoStorageKey: string,
    multipartUploadId: string,
    videoId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        this.storage.videosBucket,
        videoStorageKey,
        multipartUploadId,
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'NoSuchUpload') {
        throw err;
      }
      this.logger.warn(
        `Multipart session for video ${videoId} was already gone`,
      );
    }
  }
}
