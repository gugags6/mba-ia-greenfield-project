import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job } from 'bullmq';
import { createWriteStream } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { ACCEPTED_VIDEO_CODECS } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import {
  computeThumbnailOffset,
  extractThumbnail,
} from './ffmpeg-thumbnail.util';
import {
  InvalidVideoFormatError,
  probeVideo,
  ProbeResult,
} from './ffprobe.util';

export interface ProcessVideoJobData {
  videoId: string;
  channelId: string;
  videoStorageKey: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, videoStorageKey } = job.data;

    const video = await this.videosService.findById(videoId);
    if (!video) {
      throw new Error(`Video ${videoId} not found — cannot process`);
    }

    const tmpPath = join(tmpdir(), `video-processing-${videoId}`);

    // Download is not wrapped — a transient storage/network failure here
    // should propagate so BullMQ retries the job with backoff (per TD-02).
    const objectStream = await this.storageService.getObjectStream(
      this.storage.videosBucket,
      videoStorageKey,
    );
    await pipeline(objectStream, createWriteStream(tmpPath));

    try {
      let probe: ProbeResult;
      try {
        probe = await probeVideo(tmpPath);
      } catch (err) {
        if (err instanceof InvalidVideoFormatError) {
          await this.videosService.markFailed(videoId, err.message);
          return;
        }
        throw err;
      }

      if (!(ACCEPTED_VIDEO_CODECS as readonly string[]).includes(probe.codec)) {
        await this.videosService.markFailed(
          videoId,
          `Unsupported video codec: ${probe.codec}`,
        );
        return;
      }

      await this.videosService.markProcessing(videoId, {
        duration: Math.round(probe.durationSeconds),
        metadata: {
          width: probe.width,
          height: probe.height,
          codec: probe.codec,
          bitrate: probe.bitrate,
        },
      });

      await this.generateAndStoreThumbnail(
        videoId,
        tmpPath,
        probe.durationSeconds,
      );
    } finally {
      await unlink(tmpPath).catch((err) =>
        this.logger.warn(`Failed to remove temp file ${tmpPath}: ${err}`),
      );
    }
  }

  private async generateAndStoreThumbnail(
    videoId: string,
    videoPath: string,
    durationSeconds: number,
  ): Promise<void> {
    const offsetSeconds = computeThumbnailOffset(durationSeconds);
    const thumbnailPath = join(tmpdir(), `video-thumbnail-${videoId}.jpg`);

    try {
      await extractThumbnail(videoPath, offsetSeconds, thumbnailPath);
      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = `thumbnails/${videoId}/thumbnail.jpg`;

      await this.storageService.putObject(
        this.storage.thumbnailsBucket,
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosService.markReady(videoId, thumbnailKey);
    } finally {
      await unlink(thumbnailPath).catch((err) =>
        this.logger.warn(
          `Failed to remove temp thumbnail ${thumbnailPath}: ${err}`,
        ),
      );
    }
  }
}
