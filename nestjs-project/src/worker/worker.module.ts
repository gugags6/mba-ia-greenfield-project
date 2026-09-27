import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { envValidationSchema } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { VideosModule } from '../videos/videos.module';
import {
  VIDEO_CLEANUP_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { VideoCleanupProcessor } from './video-cleanup.processor';
import { VideoCleanupScheduler } from './video-cleanup.scheduler';
import { VideoProcessingProcessor } from './video-processing.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, authConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_CLEANUP_QUEUE },
    ),
    StorageModule,
    UsersModule,
    VideosModule,
  ],
  providers: [
    VideoProcessingProcessor,
    VideoCleanupProcessor,
    VideoCleanupScheduler,
  ],
})
export class WorkerModule {}
