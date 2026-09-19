import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChatService } from './chat.service';
import { ChatChannelType, ChatMessage } from './entities/chat-message.entity';
import { User } from '../users/entities/user.entity';
import { RoomsService } from '../rooms/rooms.service';

describe('ChatService', () => {
  let service: ChatService;

  const userRepository = {
    findOneBy: jest.fn(),
  };
  const messageRepository = {
    create: jest.fn((input: unknown) => input),
    save: jest.fn(),
    find: jest.fn(),
  };

  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === User) return userRepository;
      if (entity === ChatMessage) return messageRepository;
      throw new Error(`unexpected entity: ${String(entity)}`);
    },
  };

  const roomsService = {
    findActiveMember: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    messageRepository.create.mockImplementation((input: unknown) => input);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: DataSource, useValue: dataSource },
        { provide: RoomsService, useValue: roomsService },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  describe('sendGlobalMessage', () => {
    it('사용자를 조회해 닉네임과 함께 저장하고 반환한다', async () => {
      userRepository.findOneBy.mockResolvedValue({
        id: 1,
        nickname: '수연',
        profileImageUrl: 'https://example.com/p.jpg',
      });
      messageRepository.save.mockResolvedValue({
        id: 10,
        content: '안녕하세요',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await service.sendGlobalMessage(1, '안녕하세요');

      expect(messageRepository.create).toHaveBeenCalledWith({
        channelType: ChatChannelType.GLOBAL,
        roomId: null,
        userId: 1,
        content: '안녕하세요',
      });
      expect(result).toEqual({
        id: 10,
        roomId: null,
        userId: 1,
        nickname: '수연',
        profileImageUrl: 'https://example.com/p.jpg',
        content: '안녕하세요',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
    });

    it('닉네임이 없으면 익명으로 대체한다', async () => {
      userRepository.findOneBy.mockResolvedValue({
        id: 1,
        nickname: null,
        profileImageUrl: null,
      });
      messageRepository.save.mockResolvedValue({
        id: 11,
        content: 'hi',
        createdAt: new Date(),
      });

      const result = await service.sendGlobalMessage(1, 'hi');

      expect(result.nickname).toBe('익명');
    });

    it('존재하지 않는 사용자면 NotFoundException을 던진다', async () => {
      userRepository.findOneBy.mockResolvedValue(null);

      await expect(service.sendGlobalMessage(999, 'hi')).rejects.toThrow(
        NotFoundException,
      );
      expect(messageRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('sendRoomMessage', () => {
    it('활성 참여자 검증(findActiveMember)을 재사용해 권한과 닉네임을 함께 처리한다', async () => {
      roomsService.findActiveMember.mockResolvedValue({
        memberId: 5,
        userId: 1,
        nickname: '수연',
        profileImageUrl: null,
        isReady: true,
        isHost: true,
      });
      messageRepository.save.mockResolvedValue({
        id: 20,
        content: '방 채팅',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });

      const result = await service.sendRoomMessage(7, 1, '방 채팅');

      expect(roomsService.findActiveMember).toHaveBeenCalledWith(7, 1);
      expect(messageRepository.create).toHaveBeenCalledWith({
        channelType: ChatChannelType.ROOM,
        roomId: 7,
        userId: 1,
        content: '방 채팅',
      });
      expect(result).toEqual({
        id: 20,
        roomId: 7,
        userId: 1,
        nickname: '수연',
        profileImageUrl: null,
        content: '방 채팅',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
    });

    it('활성 참여자가 아니면 findActiveMember가 던지는 예외를 그대로 전파하고 저장하지 않는다', async () => {
      roomsService.findActiveMember.mockRejectedValue(
        new Error('현재 방에 참여 중인 사용자가 아닙니다.'),
      );

      await expect(service.sendRoomMessage(7, 999, 'hi')).rejects.toThrow();
      expect(messageRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('findGlobalMessages / findRoomMessages', () => {
    it('최신순으로 조회한 뒤 오래된 순으로 뒤집어 반환한다', async () => {
      messageRepository.find.mockResolvedValue([
        {
          id: 3,
          roomId: null,
          userId: 1,
          user: { nickname: '수연', profileImageUrl: null },
          content: '세 번째',
          createdAt: new Date('2026-01-01T00:00:03Z'),
        },
        {
          id: 2,
          roomId: null,
          userId: 1,
          user: { nickname: '수연', profileImageUrl: null },
          content: '두 번째',
          createdAt: new Date('2026-01-01T00:00:02Z'),
        },
      ]);

      const result = await service.findGlobalMessages(1);

      expect(result.map((m) => m.content)).toEqual(['두 번째', '세 번째']);
    });

    it('beforeId를 지정하면 그보다 오래된 메시지를 조회한다', async () => {
      messageRepository.find.mockResolvedValue([]);

      await service.findGlobalMessages(1, { beforeId: 10, limit: 5 });

      const whereMatcher: unknown = expect.objectContaining({
        channelType: ChatChannelType.GLOBAL,
      });

      expect(messageRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: whereMatcher,
          take: 5,
        }),
      );
    });

    it('방 채팅 기록 조회도 활성 참여자만 허용한다', async () => {
      roomsService.findActiveMember.mockResolvedValue({
        memberId: 1,
        userId: 1,
        nickname: '수연',
        profileImageUrl: null,
        isReady: true,
        isHost: true,
      });
      messageRepository.find.mockResolvedValue([]);

      await service.findRoomMessages(7, 1);

      expect(roomsService.findActiveMember).toHaveBeenCalledWith(7, 1);
    });

    it('활성 참여자가 아니면 방 채팅 기록을 조회할 수 없다', async () => {
      roomsService.findActiveMember.mockRejectedValue(
        new Error('현재 방에 참여 중인 사용자가 아닙니다.'),
      );

      await expect(service.findRoomMessages(7, 999)).rejects.toThrow();
      expect(messageRepository.find).not.toHaveBeenCalled();
    });
  });
});
