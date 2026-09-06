import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Room } from '../../rooms/entities/room.entity';
import { GameTurn } from './game-turn.entity';

export enum GameStatus {
  COUNTDOWN = 'countdown',
  IN_PROGRESS = 'in_progress',
  FINISHED = 'finished',
  CANCELLED = 'cancelled',
}

@Entity('game_sessions')
export class GameSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({
    name: 'room_id',
    type: 'int',
  })
  roomId: number;

  @ManyToOne(() => Room, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'room_id',
  })
  room: Room;

  @Column({
    type: 'enum',
    enum: GameStatus,
    default: GameStatus.COUNTDOWN,
  })
  status: GameStatus;

  // 현재 진행 중인 턴
  @Column({
    name: 'current_turn_number',
    type: 'int',
    default: 0,
  })
  currentTurnNumber: number;

  // 게임 시작 시 Room.relayCount를 복사
  @Column({
    name: 'total_turns',
    type: 'int',
  })
  totalTurns: number;

  // 게임 시작 시 Room.timeLimitSeconds를 복사
  @Column({
    name: 'time_limit_seconds',
    type: 'int',
  })
  timeLimitSeconds: number;

  // AI가 제공한 최초 이미지
  @Column({
    name: 'initial_image_key',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  initialImageKey: string | null;

  @Column({
    name: 'started_at',
    type: 'timestamptz',
    nullable: true,
  })
  startedAt: Date | null;

  @Column({
    name: 'finished_at',
    type: 'timestamptz',
    nullable: true,
  })
  finishedAt: Date | null;

  @OneToMany(() => GameTurn, (turn) => turn.gameSession)
  turns: GameTurn[];

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

  @Column({
    name: 'countdown_ends_at',
    type: 'timestamptz',
    nullable: true,
  })
  countdownEndsAt: Date | null;
}
