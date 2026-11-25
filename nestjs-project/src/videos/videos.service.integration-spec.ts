import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { useTestBucket } from '../test/test-bucket';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VideoStatus } from './videos.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration: Postgres + MinIO)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let restoreBucket: () => void;
  let channel: Channel;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();
    await moduleRef.init(); // ensureBucket() on the test bucket

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storageService.abortMultipartUpload(key, uploadId);
    }
    await moduleRef.close();
    restoreBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
  });

  describe('initiateUpload', () => {
    it('should persist the draft with an upload_id that is open in the storage at videos/{id}/original', async () => {
      const result = await videosService.initiateUpload(channel.user_id, {
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 134217728,
      });

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: result.id });
      openUploads.push({ key: video.storage_key, uploadId: video.upload_id! });

      expect(video).toMatchObject({
        status: VideoStatus.DRAFT,
        channel_id: channel.id,
        storage_key: `videos/${result.id}/original`,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 134217728,
        part_size: 67108864,
        part_count: 2,
      });
      expect(video.upload_id).toEqual(expect.any(String));
      // The multipart exists and is open: ListParts succeeds with no parts yet.
      await expect(
        storageService.listParts(video.storage_key, video.upload_id!),
      ).resolves.toEqual([]);
    });
  });
});
