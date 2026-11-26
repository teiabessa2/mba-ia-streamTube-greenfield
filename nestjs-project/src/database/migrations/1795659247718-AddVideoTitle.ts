import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `videos.title` (SI-03.15). Existing rows are backfilled with the same
 * rule as `deriveVideoTitle` (src/videos/video-title.util.ts): file name
 * without its last extension, trimmed; the trimmed file name when that is
 * empty; capped at 100 characters. Only then is the column made NOT NULL.
 */
export class AddVideoTitle1795659247718 implements MigrationInterface {
  name = 'AddVideoTitle1795659247718';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "title" character varying(100)`,
    );
    await queryRunner.query(
      `UPDATE "videos" SET "title" = left(
         coalesce(
           nullif(regexp_replace(regexp_replace("original_filename", '\\.[^.]+$', ''), '^\\s+|\\s+$', '', 'g'), ''),
           regexp_replace("original_filename", '^\\s+|\\s+$', '', 'g')
         ),
         100
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "title" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "title"`);
  }
}
