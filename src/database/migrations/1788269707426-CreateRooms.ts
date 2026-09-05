import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRooms1788269707426 implements MigrationInterface {
    name = 'CreateRooms1788269707426'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."rooms_status_enum" AS ENUM('waiting', 'in_progress', 'finished')`);
        await queryRunner.query(`CREATE TABLE "rooms" ("id" SERIAL NOT NULL, "title" character varying(100) NOT NULL, "host_id" integer NOT NULL, "max_participants" integer NOT NULL DEFAULT '10', "is_public" boolean NOT NULL DEFAULT true, "invite_code" character varying(20), "time_limit_seconds" integer NOT NULL DEFAULT '600', "relay_count" integer NOT NULL DEFAULT '10', "status" "public"."rooms_status_enum" NOT NULL DEFAULT 'waiting', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0368a2d7c215f2d0458a54933f2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4ff9a8b902b374939c6e73fc48" ON "rooms" ("host_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d92dfd1fbc0de7ad349a18bc06" ON "rooms" ("invite_code") `);
        await queryRunner.query(`ALTER TABLE "rooms" ADD CONSTRAINT "FK_4ff9a8b902b374939c6e73fc48e" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "rooms" DROP CONSTRAINT "FK_4ff9a8b902b374939c6e73fc48e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d92dfd1fbc0de7ad349a18bc06"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4ff9a8b902b374939c6e73fc48"`);
        await queryRunner.query(`DROP TABLE "rooms"`);
        await queryRunner.query(`DROP TYPE "public"."rooms_status_enum"`);
    }

}
