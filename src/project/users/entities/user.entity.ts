import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    name: 'kakao_user_id',
    type: 'varchar',
    unique: true,
  })
  kakaoUserId: string;

  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  email: string | null;

  // 카카오 로그인 회원은 비밀번호가 없음
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
    select: false,
  })
  passwordHash: string | null;

  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  nickname: string | null;

  @Column({
    name: 'birth_date',
    type: 'date',
    nullable: true,
  })
  birthDate: string | null;

  @Column({
    name: 'profile_image_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  profileImageUrl: string | null;

  @Column({
    name: 'registration_completed',
    type: 'boolean',
    default: false,
  })
  registrationCompleted: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt: Date;
}
