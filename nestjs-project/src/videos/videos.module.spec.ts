import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video]), ChannelsModule, StorageModule and QueueModule', async () => {
    // compile() does not run onModuleInit, so no storage connection is opened.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    await moduleRef.close();
  }, 15000);
});
