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
  // 사용자 ID
  @PrimaryGeneratedColumn()
  id: number;

  // 이메일
  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 255,
  })
  email: string;

  // 비밀번호: 평문이 아니라 암호화된 값 저장
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    select: false,
  })
  passwordHash: string;

  // 닉네임
  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 30,
  })
  nickname: string;

  // 생년월일
  @Column({
    name: 'birth_date',
    type: 'date',
    nullable: true,
  })
  birthDate: string | null;

  // 프로필 이미지 주소
  @Column({
    name: 'profile_image_url',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  profileImageUrl: string | null;

  // 생성일
  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;

  // 수정일
  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt: Date;
}
