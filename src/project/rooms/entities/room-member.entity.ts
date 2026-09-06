import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Room } from './room.entity';
import { User } from '../../users/entities/user.entity';

@Entity('room_members')
@Index(['roomId', 'userId'], { unique: true })
export class RoomMember {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'room_id', type: 'int' })
  roomId: number;

  @ManyToOne(() => Room, (room) => room.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({
    name: 'is_ready',
    type: 'boolean',
    default: false,
  })
  isReady: boolean;

  // 게임 진행 순서
  @Column({
    name: 'turn_order',
    type: 'int',
    nullable: true,
  })
  turnOrder: number | null;

  @CreateDateColumn({
    name: 'joined_at',
    type: 'timestamptz',
  })
  joinedAt: Date;

  @Column({
    name: 'left_at',
    type: 'timestamptz',
    nullable: true,
  })
  leftAt: Date | null;
}
