import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChatMessages1789827713215 implements MigrationInterface {
  name = 'CreateChatMessages1789827713215';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."chat_messages_channel_type_enum" AS ENUM('global', 'room')`,
    );
    await queryRunner.query(
      `CREATE TABLE "chat_messages" ("id" SERIAL NOT NULL, "channel_type" "public"."chat_messages_channel_type_enum" NOT NULL, "room_id" integer, "user_id" integer NOT NULL, "content" character varying(500) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_40c55ee0e571e268b0d3cd37d10" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5588b6cea298cedec7063c0d33" ON "chat_messages" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_86badf4d27189d624648185724" ON "chat_messages" ("channel_type", "room_id", "id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD CONSTRAINT "FK_5588b6cea298cedec7063c0d33e" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_5588b6cea298cedec7063c0d33e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_86badf4d27189d624648185724"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5588b6cea298cedec7063c0d33"`,
    );
    await queryRunner.query(`DROP TABLE "chat_messages"`);
    await queryRunner.query(
      `DROP TYPE "public"."chat_messages_channel_type_enum"`,
    );
  }
}
