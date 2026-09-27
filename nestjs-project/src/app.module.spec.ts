import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from './app.module';
import { VIDEO_PROCESSING_QUEUE } from './queue/queue.constants';

describe('AppModule (fila)', () => {
  it('should compile with BullModule.forRootAsync + registerQueue(video-processing)', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();

    await module.close();
  }, 30000);
});
