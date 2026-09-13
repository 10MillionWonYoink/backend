import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiEvaluationFields1789320585850 implements MigrationInterface {
  name = 'AddAiEvaluationFields1789320585850';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "game_turns" ADD "ai_score" integer`);
    await queryRunner.query(`ALTER TABLE "game_turns" ADD "ai_feedback" text`);
    await queryRunner.query(
      `CREATE TYPE "public"."game_turns_ai_evaluation_status_enum" AS ENUM('pending', 'completed', 'failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_turns" ADD "ai_evaluation_status" "public"."game_turns_ai_evaluation_status_enum" NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_turns" ADD "ai_evaluated_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_sessions" ADD "topic" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "game_sessions" DROP COLUMN "topic"`);
    await queryRunner.query(
      `ALTER TABLE "game_turns" DROP COLUMN "ai_evaluated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_turns" DROP COLUMN "ai_evaluation_status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."game_turns_ai_evaluation_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_turns" DROP COLUMN "ai_feedback"`,
    );
    await queryRunner.query(`ALTER TABLE "game_turns" DROP COLUMN "ai_score"`);
  }
}
