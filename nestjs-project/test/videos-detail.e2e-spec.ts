import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('videos-detail', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
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
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    let capturedToken = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string; sub: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    const { access_token } = res.body as { access_token: string };
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${access_token}`);
    return { access_token, sub: (me.body as { sub: string }).sub };
  }

  async function seedVideo(
    channelId: string,
    overrides: Partial<Video>,
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: 'Detail video',
        slug: `detail${Date.now()}${Math.random().toString(36).slice(2, 5)}`.slice(
          0,
          16,
        ),
        status: VideoStatus.DRAFT,
        ...overrides,
      }),
    );
  }

  describe('GET /videos/:slug', () => {
    it('returns 200 with metadata for a ready video without authentication', async () => {
      const { sub } = await registerConfirmAndLogin('detailowner1@example.com');
      const channel = await channelRepository.findOne({
        where: { user_id: sub },
      });
      const video = await seedVideo(channel!.id, { status: VideoStatus.READY });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          id: video.id,
          slug: video.slug,
          title: video.title,
          description: video.description,
          status: 'ready',
          duration: video.duration,
          metadata: video.metadata,
          channel: expect.objectContaining({
            id: channel!.id,
            nickname: channel!.nickname,
          }) as unknown,
        }),
      );
      expect((res.body as { createdAt?: string }).createdAt).toBeDefined();
    });

    it('returns 404 VIDEO_NOT_FOUND for a non-ready video requested anonymously', async () => {
      const { sub } = await registerConfirmAndLogin('detailowner2@example.com');
      const channel = await channelRepository.findOne({
        where: { user_id: sub },
      });
      const video = await seedVideo(channel!.id, { status: VideoStatus.DRAFT });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 200 with status draft for a non-ready video requested by its own owner', async () => {
      const { access_token, sub } = await registerConfirmAndLogin(
        'detailowner3@example.com',
      );
      const channel = await channelRepository.findOne({
        where: { user_id: sub },
      });
      const video = await seedVideo(channel!.id, { status: VideoStatus.DRAFT });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect((res.body as { status: string }).status).toBe('draft');
    });
  });
});
