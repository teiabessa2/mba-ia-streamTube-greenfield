import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1795621684480 } from './migrations/1795621684480-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

/**
 * Drops every table (including TypeORM's `migrations` table) and every enum
 * type in the `public` schema, so the suite starts from an empty schema no
 * matter what a previous (possibly aborted) run left behind. Extensions are
 * kept on purpose: migrations depend on `uuid_generate_v4()`.
 * Statements run sequentially to avoid lock contention between CASCADE drops.
 */
async function resetPublicSchema(dataSource: DataSource): Promise<void> {
  const tables = await dataSource.query<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  for (const { tablename } of tables) {
    await dataSource.query(
      `DROP TABLE IF EXISTS "public"."${tablename}" CASCADE`,
    );
  }

  const enums = await dataSource.query<{ typname: string }[]>(
    `SELECT t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'`,
  );
  for (const { typname } of enums) {
    await dataSource.query(`DROP TYPE IF EXISTS "public"."${typname}" CASCADE`);
  }
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1795621684480,
        ],
      },
    );

    await dataSource.initialize();
    await resetPublicSchema(dataSource);
  });

  afterAll(async () => {
    try {
      // The revert tests undo the last migrations, leaving tables missing.
      // Re-apply so the shared DB is fully migrated when subsequent suites run.
      if (dataSource?.isInitialized) {
        await dataSource.runMigrations();
      }
    } finally {
      // Always release the connection, otherwise Jest never exits.
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    }
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the video_status enum and the videos indexes', async () => {
    const enumValues = await dataSource.query<{ enumlabel: string }[]>(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'video_status'
        ORDER BY e.enumsortorder`,
    );
    expect(enumValues.map((r) => r.enumlabel)).toEqual([
      'draft',
      'processing',
      'ready',
      'failed',
    ]);

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'videos'`,
    );
    const defs = indexes.map((r) => r.indexdef);
    expect(defs).toContainEqual(
      expect.stringMatching(/CREATE UNIQUE INDEX .* \(public_id\)/),
    );
    expect(defs).toContainEqual(
      expect.stringMatching(/CREATE INDEX .* \(channel_id\)/),
    );
  });

  it('should revert CreateVideos and remove the videos table and the video_status enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'video_status'`,
    );
    expect(enums).toHaveLength(0);
  });

  it('should then revert CreateAuthTokens and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
