import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnauthorizedVideoAccessException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { MULTIPART_PART_SIZE_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

const storageConfig = {
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: 'streamtube',
  secretAccessKey: 'streamtube',
  videosBucket: 'streamtube-videos',
  thumbnailsBucket: 'streamtube-thumbnails',
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.channel_id = 'channel-id';
  video.title = 'My video';
  video.description = null;
  video.slug = 'abcdefghijklmnop';
  video.status = VideoStatus.DRAFT;
  video.video_storage_key = null;
  video.thumbnail_storage_key = null;
  video.multipart_upload_id = null;
  video.duration = null;
  video.size_bytes = null;
  video.metadata = null;
  video.error_reason = null;
  video.created_at = new Date();
  video.updated_at = new Date();
  Object.assign(video, overrides);
  return video;
}

function makeUniqueSlugError(): QueryFailedError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as QueryFailedError & {
    code: string;
    detail: string;
  };
  err.code = '23505';
  err.detail = 'Key (slug)=(abc) already exists.';
  return err;
}

function makeQueue() {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

describe('VideosService', () => {
  describe('createUploadIntent', () => {
    const dto = {
      title: 'My video',
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 120 * 1024 * 1024, // 120MB
    };

    function makeDeps(videoOverrides: Partial<Video> = {}) {
      const video = makeVideo(videoOverrides);
      const videoRepository = {
        findOne: jest.fn(),
        create: jest.fn().mockReturnValue(video),
        save: jest.fn().mockResolvedValue(video),
      };
      const channelsService = {
        findByUserId: jest
          .fn()
          .mockResolvedValue({ id: 'channel-id', user_id: 'user-id' }),
      };
      const storageService = {
        createMultipartUpload: jest.fn().mockResolvedValue('upload-id-123'),
        completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
        getPresignedPartUrl: jest
          .fn()
          .mockImplementation(
            (
              _bucket: string,
              _key: string,
              _uploadId: string,
              partNumber: number,
            ) => Promise.resolve(`https://minio/part-${partNumber}`),
          ),
      };
      const queue = makeQueue();
      return { video, videoRepository, channelsService, storageService, queue };
    }

    it('creates a draft video, starts a multipart session, and returns presigned part URLs', async () => {
      const { video, videoRepository, channelsService, storageService, queue } =
        makeDeps();
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      const result = await service.createUploadIntent('user-id', dto as any);

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-id',
          title: 'My video',
          status: VideoStatus.DRAFT,
        }),
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'streamtube-videos',
        `videos/${video.id}/original`,
        'video/mp4',
      );
      // 120MB / 50MB per part => 3 parts
      expect(result.partUrls).toHaveLength(3);
      expect(result.partUrls[0]).toEqual({
        partNumber: 1,
        url: 'https://minio/part-1',
      });
      expect(result.uploadId).toBe('upload-id-123');
      expect(result.video).toEqual({
        id: video.id,
        slug: video.slug,
        title: video.title,
        status: VideoStatus.DRAFT,
      });
    });

    it('computes exactly 1 part for sizes at or below the per-part limit', async () => {
      const { videoRepository, channelsService, storageService, queue } =
        makeDeps();
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      const result = await service.createUploadIntent('user-id', {
        ...dto,
        sizeBytes: MULTIPART_PART_SIZE_BYTES,
      } as any);

      expect(result.partUrls).toHaveLength(1);
    });

    it('throws ChannelNotFoundException when the authenticated user has no channel', async () => {
      const { videoRepository, channelsService, storageService, queue } =
        makeDeps();
      channelsService.findByUserId.mockResolvedValue(null);
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      await expect(
        service.createUploadIntent('user-id', dto as any),
      ).rejects.toThrow(ChannelNotFoundException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('retries slug generation on unique constraint collision', async () => {
      const { video, videoRepository, channelsService, storageService, queue } =
        makeDeps();
      videoRepository.save
        .mockRejectedValueOnce(makeUniqueSlugError())
        .mockResolvedValueOnce(video)
        .mockResolvedValueOnce(video);
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      const result = await service.createUploadIntent('user-id', dto as any);

      expect(videoRepository.save).toHaveBeenCalledTimes(3);
      expect(result.video.id).toBe(video.id);
    });
  });

  describe('confirmUpload', () => {
    const dto = { parts: [{ partNumber: 1, eTag: 'etag-1' }] };

    function makeDeps(videoOverrides: Partial<Video> = {}) {
      const video = makeVideo({
        video_storage_key: 'videos/video-id/original',
        multipart_upload_id: 'upload-id-123',
        ...videoOverrides,
      });
      const videoRepository = {
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn().mockResolvedValue(video),
      };
      const channelsService = {
        findByUserId: jest
          .fn()
          .mockResolvedValue({ id: 'channel-id', user_id: 'user-id' }),
      };
      const storageService = {
        completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      };
      const queue = makeQueue();
      return { video, videoRepository, channelsService, storageService, queue };
    }

    it('completes the multipart upload, marks the video uploaded, and enqueues process-video', async () => {
      const { video, videoRepository, channelsService, storageService, queue } =
        makeDeps();
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      const result = await service.confirmUpload(
        'user-id',
        video.slug,
        dto as any,
      );

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'streamtube-videos',
        video.video_storage_key,
        video.multipart_upload_id,
        [{ PartNumber: 1, ETag: 'etag-1' }],
      );
      expect(video.status).toBe(VideoStatus.UPLOADED);
      expect(videoRepository.save).toHaveBeenCalledWith(video);
      expect(queue.add).toHaveBeenCalledWith('process-video', {
        videoId: video.id,
        channelId: video.channel_id,
        videoStorageKey: video.video_storage_key,
      });
      expect(result).toEqual({
        status: 'uploaded',
        message: expect.any(String) as string,
      });
    });

    it('throws VideoNotFoundException when the slug does not resolve to a video', async () => {
      const { videoRepository, channelsService, storageService, queue } =
        makeDeps();
      videoRepository.findOne.mockResolvedValue(null);
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      await expect(
        service.confirmUpload('user-id', 'missing-slug', dto as any),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws UnauthorizedVideoAccessException when the caller does not own the video', async () => {
      const { video, videoRepository, channelsService, storageService, queue } =
        makeDeps();
      channelsService.findByUserId.mockResolvedValue({
        id: 'someone-elses-channel',
        user_id: 'user-id',
      });
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      await expect(
        service.confirmUpload('user-id', video.slug, dto as any),
      ).rejects.toThrow(UnauthorizedVideoAccessException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws InvalidVideoStateException when the video is not in draft status', async () => {
      const { video, videoRepository, channelsService, storageService, queue } =
        makeDeps({ status: VideoStatus.READY });
      const service = new VideosService(
        videoRepository as any,
        channelsService as any,
        storageService as any,
        storageConfig as any,
        queue as any,
      );

      await expect(
        service.confirmUpload('user-id', video.slug, dto as any),
      ).rejects.toThrow(InvalidVideoStateException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('findBySlug', () => {
    function makeDeps(videoOverrides: Partial<Video> = {}) {
      const video = makeVideo({
        status: VideoStatus.READY,
        channel: { id: 'channel-id', nickname: 'chan' } as Channel,
        ...videoOverrides,
      });
      const videoRepository = {
        findOne: jest.fn().mockResolvedValue(video),
      };
      const channelsService = {
        findByUserId: jest.fn().mockResolvedValue(null),
      };
      const storageService = {};
      const queue = makeQueue();
      return { video, videoRepository, channelsService, storageService, queue };
    }

    function makeService(deps: ReturnType<typeof makeDeps>) {
      return new VideosService(
        deps.videoRepository as any,
        deps.channelsService as any,
        deps.storageService as any,
        storageConfig as any,
        deps.queue as any,
      );
    }

    it('returns video details for a ready video with no authentication', async () => {
      const deps = makeDeps();
      const service = makeService(deps);

      const result = await service.findBySlug(deps.video.slug);

      expect(deps.videoRepository.findOne).toHaveBeenCalledWith({
        where: { slug: deps.video.slug },
        relations: ['channel'],
      });
      expect(result).toEqual({
        id: deps.video.id,
        slug: deps.video.slug,
        title: deps.video.title,
        description: deps.video.description,
        status: VideoStatus.READY,
        duration: deps.video.duration,
        metadata: deps.video.metadata,
        createdAt: deps.video.created_at,
        channel: { id: 'channel-id', nickname: 'chan' },
      });
    });

    it('throws VideoNotFoundException when the slug does not exist', async () => {
      const deps = makeDeps();
      deps.videoRepository.findOne.mockResolvedValue(null);
      const service = makeService(deps);

      await expect(service.findBySlug('missing')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotFoundException for a non-ready video and an anonymous caller', async () => {
      const deps = makeDeps({ status: VideoStatus.DRAFT });
      const service = makeService(deps);

      await expect(service.findBySlug(deps.video.slug)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotFoundException for a non-ready video and a non-owner caller', async () => {
      const deps = makeDeps({ status: VideoStatus.PROCESSING });
      deps.channelsService.findByUserId.mockResolvedValue({
        id: 'someone-elses-channel',
        user_id: 'user-id',
      });
      const service = makeService(deps);

      await expect(
        service.findBySlug(deps.video.slug, 'user-id'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('returns video details for a non-ready video when the caller is the owner', async () => {
      const deps = makeDeps({ status: VideoStatus.PROCESSING });
      deps.channelsService.findByUserId.mockResolvedValue({
        id: 'channel-id',
        user_id: 'user-id',
      });
      const service = makeService(deps);

      const result = await service.findBySlug(deps.video.slug, 'user-id');

      expect(result.status).toBe(VideoStatus.PROCESSING);
    });
  });

  describe('getStreamRedirectUrl / getDownloadRedirectUrl', () => {
    function makeDeps(videoOverrides: Partial<Video> = {}) {
      const video = makeVideo({
        status: VideoStatus.READY,
        video_storage_key: 'videos/video-id/original',
        title: 'My "cool" video',
        ...videoOverrides,
      });
      const videoRepository = { findOne: jest.fn().mockResolvedValue(video) };
      const channelsService = {};
      const storageService = {
        getPresignedGetUrl: jest
          .fn()
          .mockResolvedValue('https://minio/presigned-get-url'),
      };
      const queue = makeQueue();
      return { video, videoRepository, channelsService, storageService, queue };
    }

    function makeService(deps: ReturnType<typeof makeDeps>) {
      return new VideosService(
        deps.videoRepository as any,
        deps.channelsService as any,
        deps.storageService as any,
        storageConfig as any,
        deps.queue as any,
      );
    }

    it('getStreamRedirectUrl returns a presigned GET URL for a ready video', async () => {
      const deps = makeDeps();
      const service = makeService(deps);

      const url = await service.getStreamRedirectUrl(deps.video.slug);

      expect(url).toBe('https://minio/presigned-get-url');
      expect(deps.storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        'streamtube-videos',
        deps.video.video_storage_key,
      );
    });

    it('getDownloadRedirectUrl requests a Content-Disposition attachment override with a sanitized filename', async () => {
      const deps = makeDeps();
      const service = makeService(deps);

      await service.getDownloadRedirectUrl(deps.video.slug);

      expect(deps.storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        'streamtube-videos',
        deps.video.video_storage_key,
        {
          responseContentDisposition:
            'attachment; filename="My cool video.mp4"',
        },
      );
    });

    it('throws VideoNotFoundException for a non-ready video on stream', async () => {
      const deps = makeDeps({ status: VideoStatus.DRAFT });
      const service = makeService(deps);

      await expect(
        service.getStreamRedirectUrl(deps.video.slug),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotFoundException for a non-ready video on download', async () => {
      const deps = makeDeps({ status: VideoStatus.FAILED });
      const service = makeService(deps);

      await expect(
        service.getDownloadRedirectUrl(deps.video.slug),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotFoundException when the slug does not exist', async () => {
      const deps = makeDeps();
      deps.videoRepository.findOne.mockResolvedValue(null);
      const service = makeService(deps);

      await expect(
        service.getStreamRedirectUrl('missing-slug'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });
});
