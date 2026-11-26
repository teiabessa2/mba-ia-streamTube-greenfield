import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { VideoStatus } from '../videos.types';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3; // 10737418240
const PART_SIZE = 64 * 1024 * 1024;

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_STRING_DATA_RIGHT_TRUNCATION = '22001';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'video_owner@example.com',
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner Channel',
      nickname: 'owner_channel',
      user_id: user.id,
    });
  });

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: 'videos/placeholder/original',
      upload_id: 'upload-id',
      part_size: PART_SIZE,
      part_count: 1,
      ...overrides,
    });

  const pgCode = (err: unknown) =>
    (err as QueryFailedError & { driverError: { code: string } }).driverError
      .code;

  it('should default status to draft when it is not set', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a duplicate public_id with a unique violation', async () => {
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo({ public_id: publicId }));

    const err: unknown = await videoRepository
      .save(buildVideo({ public_id: publicId }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(pgCode(err)).toBe(PG_UNIQUE_VIOLATION);
  });

  it('should reject a channel_id that does not exist with a FK violation', async () => {
    const err: unknown = await videoRepository
      .save(buildVideo({ channel_id: '00000000-0000-4000-8000-000000000000' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(pgCode(err)).toBe(PG_FOREIGN_KEY_VIOLATION);
  });

  it('should reject a video without title with a NOT NULL violation', async () => {
    const err: unknown = await videoRepository
      .save(buildVideo({ title: undefined }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(pgCode(err)).toBe(PG_NOT_NULL_VIOLATION);
  });

  it('should persist a 100-character title and reject 101 characters', async () => {
    const saved = await videoRepository.save(
      buildVideo({ title: 'a'.repeat(100) }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.title).toBe('a'.repeat(100));

    const err: unknown = await videoRepository
      .save(buildVideo({ title: 'a'.repeat(101) }))
      .catch((e: unknown) => e);
    expect(pgCode(err)).toBe(PG_STRING_DATA_RIGHT_TRUNCATION);
  });

  it('should reject a status outside draft/processing/ready/failed', async () => {
    const err: unknown = await videoRepository
      .save(buildVideo({ status: 'archived' as VideoStatus }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueryFailedError);
    expect(pgCode(err)).toBe(PG_INVALID_TEXT_REPRESENTATION);
  });

  it('should persist size_bytes = 10737418240 without loss and read it back as a number', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        size_bytes: MAX_VIDEO_SIZE_BYTES,
        part_count: MAX_VIDEO_SIZE_BYTES / PART_SIZE,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should round-trip metadata as jsonb and keep nullable columns null on a draft', async () => {
    const metadata = {
      width: 320,
      height: 240,
      videoCodec: 'h264',
      bitrate: 128000,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      sizeBytes: 1024,
    };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.failure_reason).toBeNull();
  });
});
