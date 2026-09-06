import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateGame1788607704604 implements MigrationInterface {
    name = 'CreateGame1788607704604'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."game_turns_status_enum" AS ENUM('waiting', 'in_progress', 'submitted', 'expired')`);
        await queryRunner.query(`CREATE TABLE "game_turns" ("id" SERIAL NOT NULL, "game_session_id" integer NOT NULL, "user_id" integer NOT NULL, "turn_number" integer NOT NULL, "status" "public"."game_turns_status_enum" NOT NULL DEFAULT 'waiting', "image_key" character varying(500), "started_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE, "submitted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a9759df3f0412faf282578a7cae" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_13229f45a10837a99e075ad454" ON "game_turns" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a67e37238e6311f63b60eea681" ON "game_turns" ("game_session_id", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59acb217c0b6b3999f5efa4326" ON "game_turns" ("game_session_id", "turn_number") `);
        await queryRunner.query(`CREATE TYPE "public"."game_sessions_status_enum" AS ENUM('countdown', 'in_progress', 'finished', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "game_sessions" ("id" SERIAL NOT NULL, "room_id" integer NOT NULL, "status" "public"."game_sessions_status_enum" NOT NULL DEFAULT 'countdown', "current_turn_number" integer NOT NULL DEFAULT '0', "total_turns" integer NOT NULL, "time_limit_seconds" integer NOT NULL, "initial_image_key" character varying(500), "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e25fa82d55744e55000c3288fdc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_40c8af9e336cbb3ed9442e5e0e" ON "game_sessions" ("room_id") `);
        await queryRunner.query(`ALTER TABLE "game_turns" ADD CONSTRAINT "FK_ab20b60b13124ae9cbdf036c4bf" FOREIGN KEY ("game_session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "game_turns" ADD CONSTRAINT "FK_13229f45a10837a99e075ad4542" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "game_sessions" ADD CONSTRAINT "FK_40c8af9e336cbb3ed9442e5e0e8" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "game_sessions" DROP CONSTRAINT "FK_40c8af9e336cbb3ed9442e5e0e8"`);
        await queryRunner.query(`ALTER TABLE "game_turns" DROP CONSTRAINT "FK_13229f45a10837a99e075ad4542"`);
        await queryRunner.query(`ALTER TABLE "game_turns" DROP CONSTRAINT "FK_ab20b60b13124ae9cbdf036c4bf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_40c8af9e336cbb3ed9442e5e0e"`);
        await queryRunner.query(`DROP TABLE "game_sessions"`);
        await queryRunner.query(`DROP TYPE "public"."game_sessions_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_59acb217c0b6b3999f5efa4326"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a67e37238e6311f63b60eea681"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_13229f45a10837a99e075ad454"`);
        await queryRunner.query(`DROP TABLE "game_turns"`);
        await queryRunner.query(`DROP TYPE "public"."game_turns_status_enum"`);
    }

}
