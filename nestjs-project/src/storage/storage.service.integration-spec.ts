import { S3Client, ListPartsCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;
  const bucket = 'streamtube-videos';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  it('getPresignedPutUrl returns a valid signed URL for the videos bucket', async () => {
    const url = await storageService.getPresignedPutUrl(
      bucket,
      `test/${Date.now()}-put.mp4`,
    );

    expect(url).toMatch(/^http:\/\/minio:9000\/streamtube-videos\//);
    expect(url).toContain('X-Amz-Signature=');
  });

  it('createMultipartUpload followed by abortMultipartUpload removes the multipart session', async () => {
    const key = `test/${Date.now()}-multipart.mp4`;

    const uploadId = await storageService.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    expect(uploadId).toEqual(expect.any(String));
    expect(uploadId.length).toBeGreaterThan(0);

    await storageService.abortMultipartUpload(bucket, key, uploadId);

    const client = new S3Client({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'streamtube', secretAccessKey: 'streamtube' },
    });

    await expect(
      client.send(
        new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      ),
    ).rejects.toThrow();
  });
});
