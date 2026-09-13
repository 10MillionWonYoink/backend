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
import { GameSession } from './game-session.entity';

export enum GameTurnStatus {
  WAITING = 'waiting',
  IN_PROGRESS = 'in_progress',
  SUBMITTED = 'submitted',
  EXPIRED = 'expired',
}

// GameTurnStatus(턴 진행 상태)와는 별개로, 제출된 사진의 AI 채점 진행 상태를 나타낸다.
export enum GameTurnEvaluationStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('game_turns')
@Index(['gameSessionId', 'turnNumber'], { unique: true })
@Index(['gameSessionId', 'status'])
export class GameTurn {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    name: 'game_session_id',
    type: 'int',
  })
  gameSessionId: number;

  @ManyToOne(() => GameSession, (gameSession) => gameSession.turns, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'game_session_id',
  })
  gameSession: GameSession;

  // 해당 턴을 진행할 사용자
  @Index()
  @Column({
    name: 'user_id',
    type: 'int',
  })
  userId: number;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'user_id',
  })
  user: User;

  @Column({
    name: 'turn_number',
    type: 'int',
  })
  turnNumber: number;

  @Column({
    type: 'enum',
    enum: GameTurnStatus,
    default: GameTurnStatus.WAITING,
  })
  status: GameTurnStatus;

  // S3 전체 URL보다 객체 Key 저장 권장
  @Column({
    name: 'image_key',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  imageKey: string | null;

  @Column({
    name: 'started_at',
    type: 'timestamptz',
    nullable: true,
  })
  startedAt: Date | null;

  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiresAt: Date | null;

  @Column({
    name: 'submitted_at',
    type: 'timestamptz',
    nullable: true,
  })
  submittedAt: Date | null;

  // 제출된 사진에 대한 AI(Gemini) 채점 결과 (0~100). 미채점/채점 실패 시 null.
  @Column({
    name: 'ai_score',
    type: 'int',
    nullable: true,
  })
  aiScore: number | null;

  // AI가 남긴 짧은 평가 코멘트
  @Column({
    name: 'ai_feedback',
    type: 'text',
    nullable: true,
  })
  aiFeedback: string | null;

  @Column({
    name: 'ai_evaluation_status',
    type: 'enum',
    enum: GameTurnEvaluationStatus,
    default: GameTurnEvaluationStatus.PENDING,
  })
  aiEvaluationStatus: GameTurnEvaluationStatus;

  @Column({
    name: 'ai_evaluated_at',
    type: 'timestamptz',
    nullable: true,
  })
  aiEvaluatedAt: Date | null;

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
