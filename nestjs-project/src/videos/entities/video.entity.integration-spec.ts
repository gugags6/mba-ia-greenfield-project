import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `chan${n}`,
        user_id: user.id,
      }),
    );
  }

  it('should create the videos table with all Data Model columns', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
        description: 'A description',
        slug: 'abc1234567890x',
        status: VideoStatus.READY,
        video_storage_key: 'videos/abc.mp4',
        thumbnail_storage_key: 'thumbnails/abc.jpg',
        multipart_upload_id: 'upload-id',
        duration: 120,
        size_bytes: '1073741824',
        metadata: { width: 1920, height: 1080, codec: 'h264', bitrate: 5000 },
        error_reason: null,
      }),
    );

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found?.title).toBe('My video');
    expect(found?.status).toBe(VideoStatus.READY);
    expect(found?.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 5000,
    });
    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique slug constraint', async () => {
    const channel1 = await createChannel();
    const channel2 = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel1.id,
        title: 'First video',
        slug: 'duplicateslug01',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel2.id,
          title: 'Second video',
          slug: 'duplicateslug01',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft when omitted', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Draft video',
        slug: 'defaultstatus01',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });
});
