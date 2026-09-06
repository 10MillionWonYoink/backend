import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRoomAndMember1788602289075 implements MigrationInterface {
    name = 'CreateRoomAndMember1788602289075'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "room_members" ("id" SERIAL NOT NULL, "room_id" integer NOT NULL, "user_id" integer NOT NULL, "is_ready" boolean NOT NULL DEFAULT false, "turn_order" integer, "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "left_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_4493fab0433f741b7cf842e6038" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d4ea360161fd5ff21a94ae9d8a" ON "room_members" ("room_id", "user_id") `);
        await queryRunner.query(`ALTER TABLE "rooms" ADD "min_participants" integer NOT NULL DEFAULT '2'`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "max_participants" SET DEFAULT '6'`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "invite_code" SET NOT NULL`);
        await queryRunner.query(`ALTER TYPE "public"."rooms_status_enum" RENAME TO "rooms_status_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."rooms_status_enum" AS ENUM('waiting', 'countdown', 'in_progress', 'finished')`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" TYPE "public"."rooms_status_enum" USING "status"::"text"::"public"."rooms_status_enum"`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" SET DEFAULT 'waiting'`);
        await queryRunner.query(`DROP TYPE "public"."rooms_status_enum_old"`);
        await queryRunner.query(`ALTER TABLE "room_members" ADD CONSTRAINT "FK_e6cf45f179a524427ddf8bacd8e" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "room_members" ADD CONSTRAINT "FK_b2d15baf5b46ed9659bd71fbb43" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "room_members" DROP CONSTRAINT "FK_b2d15baf5b46ed9659bd71fbb43"`);
        await queryRunner.query(`ALTER TABLE "room_members" DROP CONSTRAINT "FK_e6cf45f179a524427ddf8bacd8e"`);
        await queryRunner.query(`CREATE TYPE "public"."rooms_status_enum_old" AS ENUM('waiting', 'in_progress', 'finished')`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" TYPE "public"."rooms_status_enum_old" USING "status"::"text"::"public"."rooms_status_enum_old"`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "status" SET DEFAULT 'waiting'`);
        await queryRunner.query(`DROP TYPE "public"."rooms_status_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."rooms_status_enum_old" RENAME TO "rooms_status_enum"`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "invite_code" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "rooms" ALTER COLUMN "max_participants" SET DEFAULT '10'`);
        await queryRunner.query(`ALTER TABLE "rooms" DROP COLUMN "min_participants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d4ea360161fd5ff21a94ae9d8a"`);
        await queryRunner.query(`DROP TABLE "room_members"`);
    }

}
