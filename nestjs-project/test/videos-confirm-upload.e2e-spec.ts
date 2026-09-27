import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
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
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';

describe('videos-confirm-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videoProcessingQueue: Queue;

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
    videoProcessingQueue = moduleFixture.get(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await videoProcessingQueue.obliterate({ force: true });
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
  ): Promise<{ access_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body as { access_token: string };
  }

  /** Real upload-intent -> real MinIO part PUT -> real ETag, for scenarios that must
   * reach StorageService.completeMultipartUpload (this project never mocks storage). */
  async function createDraftWithRealUpload(
    accessToken: string,
  ): Promise<{ slug: string; parts: { partNumber: number; eTag: string }[] }> {
    const intentRes = await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Confirm upload video',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(201);

    const intentBody = intentRes.body as {
      video: { slug: string };
      partUrls: { partNumber: number; url: string }[];
    };
    const { slug } = intentBody.video;
    const [{ partNumber, url }] = intentBody.partUrls;

    const putRes = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('fake video bytes'),
    });
    const eTag = (putRes.headers.get('etag') ?? '').replace(/"/g, '');
    expect(eTag.length).toBeGreaterThan(0);

    return { slug, parts: [{ partNumber, eTag }] };
  }

  /** Seeds a Video row directly for scenarios that fail before ever touching storage
   * (ownership / status checks run before StorageService.completeMultipartUpload). */
  async function seedVideo(overrides: Partial<Video>): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        title: 'Seeded video',
        slug: `seed${Date.now()}${Math.random().toString(36).slice(2, 6)}`.slice(
          0,
          16,
        ),
        status: VideoStatus.DRAFT,
        video_storage_key: 'videos/seeded/original',
        multipart_upload_id: 'seeded-upload-id',
        ...overrides,
      }),
    );
  }

  describe('POST /videos/:slug/confirm-upload', () => {
    it('confirms the upload of a draft video owned by the caller — 200, status transitions to uploaded', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'confirmowner@example.com',
      );
      const { slug, parts } = await createDraftWithRealUpload(access_token);

      await request(app.getHttpServer())
        .post(`/videos/${slug}/confirm-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(200);

      const updated = await videoRepository.findOne({ where: { slug } });
      expect(updated?.status).toBe(VideoStatus.UPLOADED);
    });

    it('enqueues a process-video job on video-processing with the correct videoId', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'confirmqueue@example.com',
      );
      const { slug, parts } = await createDraftWithRealUpload(access_token);
      const video = await videoRepository.findOne({ where: { slug } });

      await request(app.getHttpServer())
        .post(`/videos/${slug}/confirm-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(200);

      const jobs = await videoProcessingQueue.getJobs(['waiting', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual(
        expect.objectContaining({ videoId: video?.id }),
      );
    });

    it('rejects confirmation of a video owned by another channel — 403 UNAUTHORIZED_VIDEO_ACCESS', async () => {
      const owner = await registerConfirmAndLogin('confirmvictim@example.com');
      const meOwner = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${owner.access_token}`);
      const ownerChannel = await channelRepository.findOne({
        where: { user_id: (meOwner.body as { sub: string }).sub },
      });
      const video = await seedVideo({ channel_id: ownerChannel!.id });

      const { access_token } = await registerConfirmAndLogin(
        'confirmattacker@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.slug}/confirm-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'irrelevant' }] })
        .expect(403);

      expect((res.body as { error: string }).error).toBe(
        'UNAUTHORIZED_VIDEO_ACCESS',
      );
    });

    it('rejects confirmation of a video already in ready status — 409 INVALID_VIDEO_STATE', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'confirmready@example.com',
      );
      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${access_token}`);
      const channel = await channelRepository.findOne({
        where: { user_id: (me.body as { sub: string }).sub },
      });
      const video = await seedVideo({
        channel_id: channel!.id,
        status: VideoStatus.READY,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.slug}/confirm-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'irrelevant' }] })
        .expect(409);

      expect((res.body as { error: string }).error).toBe('INVALID_VIDEO_STATE');
    });
  });
});
