import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1795621684480 } from './migrations/1795621684480-CreateVideos';
import { AddVideoTitle1795659247718 } from './migrations/1795659247718-AddVideoTitle';
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
          AddVideoTitle1795659247718,
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

    expect(ranMigrations).toHaveLength(4);

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

  describe('AddVideoTitle', () => {
    let channelId: string;

    const videoColumns = async (): Promise<string[]> => {
      const rows = await dataSource.query<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'videos'
          ORDER BY column_name`,
      );
      return rows.map((r) => r.column_name);
    };

    /** A real row inserted with plain SQL, without the `title` column. */
    const insertVideoWithoutTitle = async (
      originalFilename: string,
    ): Promise<string> => {
      const [{ id }] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO "videos" ("public_id", "channel_id", "original_filename",
                               "content_type", "size_bytes", "storage_key",
                               "part_size", "part_count")
         VALUES (substr(md5(random()::text), 1, 11), $1, $2, 'video/mp4',
                 1024, 'videos/placeholder/original', 67108864, 1)
         RETURNING "id"`,
        [channelId, originalFilename],
      );
      return id;
    };

    const titleOf = async (id: string): Promise<string> => {
      const [{ title }] = await dataSource.query<{ title: string }[]>(
        `SELECT "title" FROM "videos" WHERE "id" = $1`,
        [id],
      );
      return title;
    };

    beforeAll(async () => {
      const [user] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO "users" ("email", "password")
         VALUES ('migration_owner@example.com', 'hashed') RETURNING "id"`,
      );
      const [channel] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO "channels" ("name", "nickname", "user_id")
         VALUES ('Migration Owner', 'migration_owner', $1) RETURNING "id"`,
        [user.id],
      );
      channelId = channel.id;
    });

    it('should leave videos.title as varchar(100) NOT NULL', async () => {
      const [column] = await dataSource.query<
        {
          data_type: string;
          character_maximum_length: number;
          is_nullable: string;
        }[]
      >(
        `SELECT data_type, character_maximum_length, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'videos'
            AND column_name = 'title'`,
      );

      expect(column).toEqual({
        data_type: 'character varying',
        character_maximum_length: 100,
        is_nullable: 'NO',
      });
    });

    it('should revert by dropping only the title column, keeping the other columns and the rows', async () => {
      const columnsBefore = await videoColumns();
      const [{ id }] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO "videos" ("public_id", "channel_id", "title",
                               "original_filename", "content_type",
                               "size_bytes", "storage_key", "part_size",
                               "part_count")
         VALUES ('keepRow0001', $1, 'kept', 'kept.mp4', 'video/mp4', 1024,
                 'videos/placeholder/original', 67108864, 1)
         RETURNING "id"`,
        [channelId],
      );

      await dataSource.undoLastMigration();

      expect(await videoColumns()).toEqual(
        columnsBefore.filter((c) => c !== 'title'),
      );
      const rows = await dataSource.query<{ id: string }[]>(
        `SELECT "id" FROM "videos" WHERE "id" = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      const indexes = await dataSource.query<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'videos'`,
      );
      expect(indexes.length).toBeGreaterThanOrEqual(3); // PK + public_id + channel_id
      const enums = await dataSource.query<{ typname: string }[]>(
        `SELECT typname FROM pg_type WHERE typname = 'video_status'`,
      );
      expect(enums).toHaveLength(1);

      await dataSource.query(`DELETE FROM "videos"`);
    });

    it('should backfill the title of rows inserted before up() with the deriveVideoTitle rule', async () => {
      const longName = `${'a'.repeat(251)}.mp4`;
      const ids = {
        regular: await insertVideoWithoutTitle('clip.final.mp4'),
        padded: await insertVideoWithoutTitle('  Minhas férias.mp4 '),
        onlyExtension: await insertVideoWithoutTitle('.mp4'),
        blankName: await insertVideoWithoutTitle(' .mp4'),
        long: await insertVideoWithoutTitle(longName),
      };

      const ran = await dataSource.runMigrations();

      expect(ran.map((m) => m.name)).toEqual(['AddVideoTitle1795659247718']);
      expect(await titleOf(ids.regular)).toBe('clip.final');
      expect(await titleOf(ids.padded)).toBe('Minhas férias');
      expect(await titleOf(ids.onlyExtension)).toBe('.mp4');
      expect(await titleOf(ids.blankName)).toBe('.mp4');
      expect(await titleOf(ids.long)).toBe('a'.repeat(100));

      await dataSource.query(`DELETE FROM "videos"`);
    });

    afterAll(async () => {
      await dataSource.query(`DELETE FROM "channels" WHERE "id" = $1`, [
        channelId,
      ]);
      await dataSource.query(
        `DELETE FROM "users" WHERE "email" = 'migration_owner@example.com'`,
      );
    });
  });

  it('should revert AddVideoTitle and then CreateVideos, removing the videos table and the video_status enum', async () => {
    await dataSource.undoLastMigration(); // AddVideoTitle
    await dataSource.undoLastMigration(); // CreateVideos

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
