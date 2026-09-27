import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { StringValue } from 'ms';
import authConfig from '../config/auth.config';
import { ChannelsModule } from '../channels/channels.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Only JwtModule (for OptionalJwtAuthGuard's token verification), not the
    // full AuthModule — importing AuthModule cascades into MailModule /
    // ThrottlerModule, which this module (and WorkerModule, which imports it
    // transitively) has no reason to depend on.
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: cfg.jwtAccessExpiration as StringValue },
      }),
    }),
    ChannelsModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
