import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCountdownEndsAtToGameSessions1789298658074 implements MigrationInterface {
  name = 'AddCountdownEndsAtToGameSessions1789298658074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "game_sessions" ADD "countdown_ends_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "game_sessions" DROP COLUMN "countdown_ends_at"`,
    );
  }
}
