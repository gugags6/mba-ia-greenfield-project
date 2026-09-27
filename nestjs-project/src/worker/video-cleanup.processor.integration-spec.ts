import { Job } from 'bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';
import {
  CleanupAbandonedVideosJobData,
  VideoCleanupProcessor,
} from './video-cleanup.processor';

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('VideoCleanupProcessor (integration)', () => {
  let moduleFixture: TestingModule;
  let processor: VideoCleanupProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let bucket: string;
  let s3Client: S3Client;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    processor = moduleFixture.get(VideoCleanupProcessor);
    storageService = moduleFixture.get(StorageService);
    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    const storage = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    bucket = storage.videosBucket;
    s3Client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
    });
  }, 30000);

  afterAll(async () => {
    await moduleFixture.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `cleanup_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Cleanup Channel ${n}`,
        nickname: `cleanupchan${n}`,
        user_id: user.id,
      }),
    );
  }

  async function seedVideo(
    channelId: string,
    ageHours: number,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const n = ++counter;
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: 'Abandoned draft',
        slug: `cleanup${n}${Date.now()}`.slice(0, 16),
        status: VideoStatus.DRAFT,
        ...overrides,
      }),
    );
    await dataSource.query(
      'UPDATE "videos" SET "created_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - ageHours * ONE_HOUR_MS), video.id],
    );
    return video;
  }

  function makeJob(
    data: CleanupAbandonedVideosJobData,
  ): Job<CleanupAbandonedVideosJobData> {
    return { data } as Job<CleanupAbandonedVideosJobData>;
  }

  it('removes a draft video older than 24h and aborts its multipart session in MinIO', async () => {
    const channel = await seedChannel();
    const key = `test/cleanup/${Date.now()}-expired.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    const video = await seedVideo(channel.id, 25, {
      video_storage_key: key,
      multipart_upload_id: uploadId,
    });

    await processor.process(makeJob({ olderThanHours: 24 }));

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).toBeNull();

    await expect(
      s3Client.send(
        new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      ),
    ).rejects.toThrow();
  });

  it('does not remove a draft video created less than 24h ago', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel.id, 1);

    await processor.process(makeJob({ olderThanHours: 24 }));

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).not.toBeNull();
  });

  it('removes an expired draft with no multipart session without error', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel.id, 48);

    await processor.process(makeJob({ olderThanHours: 24 }));

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).toBeNull();
  });
});
