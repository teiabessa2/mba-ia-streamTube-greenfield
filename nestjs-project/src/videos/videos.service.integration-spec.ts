import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { requestPresigned } from '../test/presigned-http';
import { useTestBucket } from '../test/test-bucket';
import { useTestQueuePrefix } from '../test/test-queue';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideosService } from './videos.service';
import { VideoStatus } from './videos.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration: Postgres + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let restoreBucket: () => void;
  let testPrefix: ReturnType<typeof useTestQueuePrefix>;
  let queue: Queue;
  let channel: Channel;
  const openUploads: { key: string; uploadId: string }[] = [];
  const completedKeys: string[] = [];

  beforeAll(async () => {
    restoreBucket = useTestBucket();
    testPrefix = useTestQueuePrefix('videos-service');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        StorageModule,
        QueueModule,
      ],
      providers: [VideosService, VideoProcessingQueue],
    }).compile();
    await moduleRef.init(); // ensureBucket() on the test bucket

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    queue = moduleRef.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEOS));
  }, 60_000);

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storageService.abortMultipartUpload(key, uploadId);
    }
    for (const key of completedKeys) {
      await storageService.deleteObject(key);
    }
    await queue.obliterate({ force: true });
    await moduleRef.close();
    restoreBucket();
    testPrefix.restore();
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

  describe('listUploadedParts', () => {
    it('should list only the part already sent by PUT to its presigned URL', async () => {
      const draft = await videosService.initiateUpload(channel.user_id, {
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 67108865, // part_count = 2
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      openUploads.push({ key: video.storage_key, uploadId: video.upload_id! });
      const body = Buffer.from('first-part-bytes');

      const {
        parts: [part1],
      } = await videosService.presignParts(channel.user_id, draft.id, [1]);
      const put = await requestPresigned(part1.url, { method: 'PUT', body });
      expect(put.statusCode).toBe(200);

      const result = await videosService.listUploadedParts(
        channel.user_id,
        draft.id,
      );

      expect(result).toEqual({
        parts: [
          { part_number: 1, etag: put.headers.etag, size_bytes: body.length },
        ],
        part_size: 67108864,
        part_count: 2,
      });
    });
  });

  describe('completeUpload', () => {
    it('should complete a real 1-part upload, move the video to processing and queue process-video', async () => {
      const body = Buffer.alloc(1024, 'v');
      const draft = await videosService.initiateUpload(channel.user_id, {
        file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length, // part_count = 1
      });
      const {
        parts: [part1],
      } = await videosService.presignParts(channel.user_id, draft.id, [1]);
      const put = await requestPresigned(part1.url, { method: 'PUT', body });
      expect(put.statusCode).toBe(200);
      completedKeys.push(`videos/${draft.id}/original`);

      const result = await videosService.completeUpload(
        channel.user_id,
        draft.id,
        [{ part_number: 1, etag: put.headers.etag as string }],
      );

      expect(result).toEqual({
        id: draft.id,
        public_id: draft.public_id,
        status: VideoStatus.PROCESSING,
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      await expect(
        storageService.headObjectSize(video.storage_key),
      ).resolves.toBe(body.length);
      const job = await queue.getJob(draft.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: draft.id });
    });
  });
});
