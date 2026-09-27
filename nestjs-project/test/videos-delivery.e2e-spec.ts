import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedVideo(overrides: Partial<Video>): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `delivery_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Delivery Channel ${n}`,
        nickname: `deliverychan${n}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Delivery video',
        slug: `delivery${n}${Date.now()}`.slice(0, 16),
        status: VideoStatus.DRAFT,
        video_storage_key: `videos/delivery-${n}/original`,
        ...overrides,
      }),
    );
  }

  describe('GET /videos/:slug/stream', () => {
    it('redirects with 302 to a presigned URL in the videos bucket for a ready video', async () => {
      const video = await seedVideo({ status: VideoStatus.READY });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .expect(302);

      expect(res.headers.location).toBeDefined();
      expect(res.headers.location).toContain('streamtube-videos');
      expect(res.headers.location).toContain('X-Amz-Signature=');
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('redirects with 302 to a presigned URL with a Content-Disposition attachment override', async () => {
      const video = await seedVideo({ status: VideoStatus.READY });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .expect(302);

      expect(res.headers.location).toContain(
        'response-content-disposition=attachment',
      );
    });
  });

  describe('non-ready video', () => {
    it('returns 404 VIDEO_NOT_FOUND on both stream and download', async () => {
      const video = await seedVideo({ status: VideoStatus.DRAFT });

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .expect(404);
      expect((streamRes.body as { error: string }).error).toBe(
        'VIDEO_NOT_FOUND',
      );

      const downloadRes = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .expect(404);
      expect((downloadRes.body as { error: string }).error).toBe(
        'VIDEO_NOT_FOUND',
      );
    });
  });
});
