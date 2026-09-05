import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum RoomStatus {
  WAITING = 'waiting',
  IN_PROGRESS = 'in_progress',
  FINISHED = 'finished',
}

@Entity('rooms')
export class Room {
  // 방 ID
  @PrimaryGeneratedColumn()
  id: number;

  // 방 제목
  @Column({ type: 'varchar', length: 100 })
  title: string;

  // 방장 ID
  @Index()
  @Column({ name: 'host_id', type: 'int' })
  hostId: number;

  // 방장 정보
  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'host_id' })
  host: User;

  // 최대 인원
  @Column({ name: 'max_participants', type: 'int', default: 10 })
  maxParticipants: number;

  // 공개 여부
  @Column({ name: 'is_public', type: 'boolean', default: true })
  isPublic: boolean;

  // 초대 코드
  @Index({ unique: true })
  @Column({
    name: 'invite_code',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  inviteCode: string | null;

  // 한 사람에게 주어지는 제한 시간(초)
  @Column({ name: 'time_limit_seconds', type: 'int', default: 600 })
  timeLimitSeconds: number;

  // 목표 릴레이 횟수
  @Column({ name: 'relay_count', type: 'int', default: 10 })
  relayCount: number;

  // 방 상태
  @Column({
    type: 'enum',
    enum: RoomStatus,
    default: RoomStatus.WAITING,
  })
  status: RoomStatus;

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
