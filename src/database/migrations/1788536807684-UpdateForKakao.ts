import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateForKakao1788536807684 implements MigrationInterface {
    name = 'UpdateForKakao1788536807684'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "kakao_user_id" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_f08fa2fa4d3718d7b5a780837bc" UNIQUE ("kakao_user_id")`);
        await queryRunner.query(`ALTER TABLE "users" ADD "registration_completed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "nickname" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "nickname" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "registration_completed"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "UQ_f08fa2fa4d3718d7b5a780837bc"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "kakao_user_id"`);
    }

}
