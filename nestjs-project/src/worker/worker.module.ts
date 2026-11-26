import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmModuleOptions } from '../database/typeorm-module.options';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

/**
 * Root module of the worker entrypoint (`worker.main.ts`, phase-03-videos/TD-04).
 * It is the only place `VideoProcessor` is registered: the API `AppModule`
 * imports the `videos` queue as a producer only.
 */
@Module({
  imports: [
    // Same load/validation and connection as the API, so both fail fast on the same .env.
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmModuleOptions),
    TypeOrmModule.forFeature([Video]),
    // Registers Channel and User, the entities behind Video#channel.
    UsersModule,
    QueueModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
