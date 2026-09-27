import { readFile } from 'fs/promises';
import { join } from 'path';
import { Job } from 'bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { cleanAllTables } from '../test/create-test-data-source';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';
import {
  ProcessVideoJobData,
  VideoProcessingProcessor,
} from './video-processing.processor';

const SAMPLE_VIDEO = join(__dirname, '../test/fixtures/sample-video.mp4');
const INVALID_VIDEO = join(__dirname, '../test/fixtures/invalid-video.mp4');

describe('VideoProcessingProcessor (integration)', () => {
  let moduleFixture: TestingModule;
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let bucket: string;
  let thumbnailsBucket: string;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    processor = moduleFixture.get(VideoProcessingProcessor);
    storageService = moduleFixture.get(StorageService);
    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    const storage = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    bucket = storage.videosBucket;
    thumbnailsBucket = storage.thumbnailsBucket;
  }, 30000);

  afterAll(async () => {
    await moduleFixture.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedVideo(videoStorageKey: string): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Worker Channel ${n}`,
        nickname: `workerchan${n}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Processing target',
        slug: `worker${n}${Date.now()}`.slice(0, 16),
        status: VideoStatus.UPLOADED,
        video_storage_key: videoStorageKey,
      }),
    );
  }

  function makeJob(data: ProcessVideoJobData): Job<ProcessVideoJobData> {
    return { data } as Job<ProcessVideoJobData>;
  }

  it('extracts duration/resolution/codec/bitrate, generates a thumbnail, and transitions to ready', async () => {
    const key = `test/worker/${Date.now()}-valid.mp4`;
    const bytes = await readFile(SAMPLE_VIDEO);
    await storageService.putObject(bucket, key, bytes, 'video/mp4');
    const video = await seedVideo(key);

    await processor.process(
      makeJob({
        videoId: video.id,
        channelId: video.channel_id,
        videoStorageKey: key,
      }),
    );

    const updated = await videoRepository.findOne({ where: { id: video.id } });
    // Metadata extraction (SI-03.6)
    expect(updated?.duration).toBeGreaterThanOrEqual(0);
    const metadata = updated?.metadata as Record<string, unknown>;
    expect(metadata.codec).toBe('h264');
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(64);
    expect(metadata.bitrate).toEqual(expect.any(Number));

    // Thumbnail generation (SI-03.7)
    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.thumbnail_storage_key).toBe(
      `thumbnails/${video.id}/thumbnail.jpg`,
    );
    const thumbnailStream = await storageService.getObjectStream(
      thumbnailsBucket,
      updated!.thumbnail_storage_key!,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of thumbnailStream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it('marks the video failed with error_reason when the file is not a valid video format', async () => {
    const key = `test/worker/${Date.now()}-invalid.mp4`;
    const bytes = await readFile(INVALID_VIDEO);
    await storageService.putObject(bucket, key, bytes, 'video/mp4');
    const video = await seedVideo(key);

    await processor.process(
      makeJob({
        videoId: video.id,
        channelId: video.channel_id,
        videoStorageKey: key,
      }),
    );

    const updated = await videoRepository.findOne({ where: { id: video.id } });
    expect(updated?.status).toBe(VideoStatus.FAILED);
    expect(updated?.error_reason).toBeTruthy();
  });
});
