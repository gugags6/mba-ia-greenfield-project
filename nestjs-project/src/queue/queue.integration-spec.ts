import { Queue, Worker } from 'bullmq';

const connection = {
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

// A dedicated, disposable queue name — never the real VIDEO_PROCESSING_QUEUE.
// Other test files compile WorkerModule, which (via @nestjs/bullmq's
// @Processor decorator) spins up a REAL live worker for that queue; a
// leftover/slow-closing instance from another test file could otherwise
// steal this test's job and process it as a real (and invalid) video job,
// making this test hang until timeout instead of ever resolving.
const TEST_QUEUE = 'queue-integration-spec-test-queue';

describe('BullMQ queue mechanics (integration)', () => {
  let queue: Queue;
  let worker: Worker<{ videoId: string }>;

  afterEach(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  it('a job enqueued on a queue is dequeued and processed by a worker', async () => {
    queue = new Queue(TEST_QUEUE, { connection });

    const processed = new Promise<{ videoId: string }>((resolve, reject) => {
      worker = new Worker<{ videoId: string }>(
        TEST_QUEUE,
        (job) => {
          resolve(job.data);
          return Promise.resolve(job.data);
        },
        { connection },
      );
      worker.on('error', reject);
    });

    await queue.add('process-video', { videoId: 'video-123' });

    const data = await processed;
    expect(data.videoId).toBe('video-123');
  }, 30000);
});
