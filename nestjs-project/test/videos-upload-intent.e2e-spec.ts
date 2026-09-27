import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('videos-upload-intent', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let channelRepository: import('typeorm').Repository<Channel>;

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
  ): Promise<{ access_token: string; refresh_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body as { access_token: string; refresh_token: string };
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      title: 'My video',
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10485760,
      ...overrides,
    };
  }

  describe('POST /videos/upload-intent', () => {
    it('returns 201 with a draft video, uploadId, and non-empty partUrls for a valid payload from the channel owner', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'videoowner@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload-intent')
        .set('Authorization', `Bearer ${access_token}`)
        .send(validPayload())
        .expect(201);

      const body = res.body as {
        video?: { status: string };
        uploadId: string;
        partUrls: unknown[];
      };
      expect(body.video).toBeDefined();
      expect(body.video?.status).toBe('draft');
      expect(typeof body.uploadId).toBe('string');
      expect(body.uploadId.length).toBeGreaterThan(0);
      expect(Array.isArray(body.partUrls)).toBe(true);
      expect(body.partUrls.length).toBeGreaterThan(0);
    });

    it('returns 400 when mimeType is outside the accepted allowlist', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'videomime@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload-intent')
        .set('Authorization', `Bearer ${access_token}`)
        .send(validPayload({ mimeType: 'application/pdf' }))
        .expect(400);

      expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 when no Authorization header is provided', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload-intent')
        .send(validPayload())
        .expect(401);
    });

    it('returns 404 with CHANNEL_NOT_FOUND when the caller has no channel', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'videonochannel@example.com',
      );
      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${access_token}`);
      await channelRepository.delete({
        user_id: (me.body as { sub: string }).sub,
      });

      const res = await request(app.getHttpServer())
        .post('/videos/upload-intent')
        .set('Authorization', `Bearer ${access_token}`)
        .send(validPayload())
        .expect(404);

      expect((res.body as { error: string }).error).toBe('CHANNEL_NOT_FOUND');
    });
  });
});
