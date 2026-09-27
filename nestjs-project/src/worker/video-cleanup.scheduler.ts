import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VIDEO_CLEANUP_QUEUE } from '../queue/queue.constants';

const SCHEDULER_ID = 'cleanup-abandoned-videos-scheduler';

/**
 * Registers the hourly repeatable job that sweeps abandoned draft uploads,
 * per phase-03-videos/TD-11. `upsertJobScheduler` creates the scheduler if
 * missing or updates it in place, so re-running this on every bootstrap is
 * idempotent — it never creates duplicate schedulers.
 */
@Injectable()
export class VideoCleanupScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(VIDEO_CLEANUP_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { pattern: '0 * * * *' },
      { name: 'cleanup-abandoned-videos', data: { olderThanHours: 24 } },
    );
  }
}
