import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull } from 'typeorm';
import { RoomsService } from './rooms.service';
import { Room, RoomStatus } from './entities/room.entity';
import { RoomMember } from './entities/room-member.entity';

describe('RoomsService', () => {
  let service: RoomsService;
  const roomRepository = { findOneBy: jest.fn() };
  const memberRepository = { find: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: DataSource,
          useValue: {
            getRepository: (entity: typeof Room | typeof RoomMember) =>
              entity === Room ? roomRepository : memberRepository,
          },
        },
        { provide: ConfigService, useValue: {} },
      ],
    }).compile();

    service = module.get<RoomsService>(RoomsService);
  });

  it('returns room and active members with display profiles in creation response format', async () => {
    const room = {
      id: 12,
      title: '테스트 방',
      hostId: 3,
      status: RoomStatus.WAITING,
      maxParticipants: 6,
      inviteCode: 'room-invite',
      timeLimitSeconds: 600,
      relayCount: 3,
    };
    const members = [
      {
        id: 1,
        roomId: 12,
        userId: 3,
        isReady: false,
        leftAt: null,
        user: { id: 3, nickname: '방장', profileImageUrl: null },
      },
      {
        id: 2,
        roomId: 12,
        userId: 7,
        isReady: true,
        leftAt: null,
        user: { id: 7, nickname: '참여자', profileImageUrl: '/avatar.png' },
      },
    ];
    roomRepository.findOneBy.mockResolvedValue(room);
    memberRepository.find.mockResolvedValue(members);

    await expect(service.findOne(12)).resolves.toEqual({
      room,
      members,
      id: 12,
      title: '테스트 방',
      status: 'WAITING',
      currentPlayers: 2,
      maxPlayers: 6,
      hostName: '방장',
      invitationCode: 'room-invite',
      players: [
        { id: 3, nickname: '방장', avatar: null, isReady: false, isHost: true },
        {
          id: 7,
          nickname: '참여자',
          avatar: '/avatar.png',
          isReady: true,
          isHost: false,
        },
      ],
      turnSeconds: 600,
      totalRounds: 3,
    });
    expect(roomRepository.findOneBy).toHaveBeenCalledWith({ id: 12 });
    expect(memberRepository.find).toHaveBeenCalledWith({
      where: { roomId: 12, leftAt: IsNull() },
      relations: { user: true },
      select: { user: { id: true, nickname: true, profileImageUrl: true } },
      order: { joinedAt: 'ASC', id: 'ASC' },
    });
  });

  it('returns an empty member list for an existing room without active members', async () => {
    const room = { id: 12, title: '테스트 방' };
    roomRepository.findOneBy.mockResolvedValue(room);
    memberRepository.find.mockResolvedValue([]);

    await expect(service.findOne(12)).resolves.toMatchObject({
      room,
      members: [],
      players: [],
      currentPlayers: 0,
    });
  });

  it.each([
    [RoomStatus.WAITING, 'WAITING'],
    [RoomStatus.COUNTDOWN, 'READY'],
    [RoomStatus.IN_PROGRESS, 'PLAYING'],
    [RoomStatus.FINISHED, 'FINISHED'],
  ])('maps %s to RoomPage status %s', async (status, expectedStatus) => {
    roomRepository.findOneBy.mockResolvedValue({ id: 12, status });
    memberRepository.find.mockResolvedValue([]);

    await expect(service.findOne(12)).resolves.toMatchObject({
      status: expectedStatus,
    });
  });

  it('throws 404 when the room does not exist', async () => {
    roomRepository.findOneBy.mockResolvedValue(null);

    await expect(service.findOne(999)).rejects.toThrow(
      new NotFoundException('방을 찾을 수 없습니다.'),
    );
    expect(memberRepository.find).not.toHaveBeenCalled();
  });
});
