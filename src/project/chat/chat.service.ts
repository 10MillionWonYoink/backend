import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { ChatChannelType, ChatMessage } from './entities/chat-message.entity';
import { User } from '../users/entities/user.entity';
import { RoomsService } from '../rooms/rooms.service';

export interface ChatMessageView {
  id: number;
  roomId: number | null;
  userId: number;
  nickname: string;
  profileImageUrl: string | null;
  content: string;
  createdAt: Date;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly roomsService: RoomsService,
  ) {}

  // 전체 채팅 메시지 전송. 방 컨텍스트가 없으므로 닉네임 조회를 위해 User를 직접 조회한다.
  async sendGlobalMessage(
    userId: number,
    content: string,
  ): Promise<ChatMessageView> {
    const userRepository = this.dataSource.getRepository(User);

    const user = await userRepository.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    const messageRepository = this.dataSource.getRepository(ChatMessage);

    const saved = await messageRepository.save(
      messageRepository.create({
        channelType: ChatChannelType.GLOBAL,
        roomId: null,
        userId,
        content,
      }),
    );

    return {
      id: saved.id,
      roomId: null,
      userId,
      nickname: user.nickname ?? '익명',
      profileImageUrl: user.profileImageUrl,
      content: saved.content,
      createdAt: saved.createdAt,
    };
  }

  // 게임방 채팅 메시지 전송. 현재 방의 활성 참여자만 보낼 수 있다 — 기존
  // RoomsService.findActiveMember를 그대로 재사용해 권한 검증과 닉네임 조회를 한 번에 처리한다.
  async sendRoomMessage(
    roomId: number,
    userId: number,
    content: string,
  ): Promise<ChatMessageView> {
    const member = await this.roomsService.findActiveMember(roomId, userId);

    const messageRepository = this.dataSource.getRepository(ChatMessage);

    const saved = await messageRepository.save(
      messageRepository.create({
        channelType: ChatChannelType.ROOM,
        roomId,
        userId,
        content,
      }),
    );

    return {
      id: saved.id,
      roomId,
      userId,
      nickname: member.nickname,
      profileImageUrl: member.profileImageUrl,
      content: saved.content,
      createdAt: saved.createdAt,
    };
  }

  async findGlobalMessages(
    userId: number,
    { limit = 50, beforeId }: { limit?: number; beforeId?: number } = {},
  ): Promise<ChatMessageView[]> {
    return this.findMessages(ChatChannelType.GLOBAL, null, { limit, beforeId });
  }

  // 방 채팅 기록 조회도 전송과 동일하게 "현재 활성 참여자"만 허용한다.
  async findRoomMessages(
    roomId: number,
    userId: number,
    { limit = 50, beforeId }: { limit?: number; beforeId?: number } = {},
  ): Promise<ChatMessageView[]> {
    await this.roomsService.findActiveMember(roomId, userId);

    return this.findMessages(ChatChannelType.ROOM, roomId, {
      limit,
      beforeId,
    });
  }

  private async findMessages(
    channelType: ChatChannelType,
    roomId: number | null,
    { limit = 50, beforeId }: { limit?: number; beforeId?: number },
  ): Promise<ChatMessageView[]> {
    const messageRepository = this.dataSource.getRepository(ChatMessage);

    const messages = await messageRepository.find({
      where: {
        channelType,
        roomId: roomId === null ? IsNull() : roomId,
        ...(beforeId ? { id: LessThan(beforeId) } : {}),
      },
      relations: { user: true },
      order: { id: 'DESC' },
      take: limit,
    });

    // 최신순으로 조회한 뒤, 화면에 바로 렌더링할 수 있도록 오래된 순으로 뒤집는다.
    return messages.reverse().map((message) => ({
      id: message.id,
      roomId: message.roomId,
      userId: message.userId,
      nickname: message.user.nickname ?? '익명',
      profileImageUrl: message.user.profileImageUrl,
      content: message.content,
      createdAt: message.createdAt,
    }));
  }
}
