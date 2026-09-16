import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTopicToGameTurns1789562219500 implements MigrationInterface {
  name = 'AddTopicToGameTurns1789562219500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "game_turns" ADD "topic" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "game_turns" DROP COLUMN "topic"`);
  }
}
