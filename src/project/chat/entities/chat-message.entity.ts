import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum ChatChannelType {
  GLOBAL = 'global',
  ROOM = 'room',
}

// 전체 채팅과 게임방 채팅을 한 테이블에서 channelType으로 구분한다.
// roomId는 전체 채팅(GLOBAL)일 때 null, 게임방 채팅(ROOM)일 때 해당 방의 id.
// Room에 대한 ORM 관계/onDelete는 두지 않는다 — 채팅 기록은 Room 생명주기와
// 느슨하게 연결되어도 충분하고(참조 무결성 강제 불필요), Room 엔티티를 이 모듈에
// 끌어들이지 않기 위함이다.
@Entity('chat_messages')
@Index(['channelType', 'roomId', 'id'])
export class ChatMessage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChatChannelType,
  })
  channelType: ChatChannelType;

  @Column({
    name: 'room_id',
    type: 'int',
    nullable: true,
  })
  roomId: number | null;

  @Index()
  @Column({
    name: 'user_id',
    type: 'int',
  })
  userId: number;

  @ManyToOne(() => User, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'user_id',
  })
  user: User;

  @Column({
    type: 'varchar',
    length: 500,
  })
  content: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt: Date;
}
