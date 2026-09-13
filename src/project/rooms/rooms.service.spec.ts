import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RoomsService } from './rooms.service';
import { Room, RoomStatus } from './entities/room.entity';
import { RoomMember } from './entities/room-member.entity';

describe('RoomsService', () => {
  let service: RoomsService;
  const queryBuilder = {
    innerJoin: jest.fn(),
    leftJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    getOne: jest.fn(),
    getMany: jest.fn(),
  };
  const roomRepository = {
    createQueryBuilder: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
  };
  const memberRepository = { find: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    queryBuilder.innerJoin.mockReturnValue(queryBuilder);
    queryBuilder.leftJoinAndSelect.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);
    queryBuilder.addOrderBy.mockReturnValue(queryBuilder);
    roomRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    queryBuilder.getMany.mockResolvedValue([]);

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

  it('활성 참여자에게 게임 진행 상태의 방 상세를 반환한다', async () => {
    const updatedAt = new Date('2026-09-13T00:00:00Z');
    const room = {
      id: 12,
      title: '테스트 방',
      hostId: 3,
      status: RoomStatus.IN_PROGRESS,
      minParticipants: 2,
      maxParticipants: 6,
      isPublic: false,
      inviteCode: 'room-invite',
      timeLimitSeconds: 600,
      relayCount: 3,
      updatedAt,
      members: [
        {
          id: 1,
          userId: 3,
          isReady: false,
          user: { nickname: '방장', profileImageUrl: null },
        },
        {
          id: 2,
          userId: 7,
          isReady: true,
          user: { nickname: '참여자', profileImageUrl: '/avatar.png' },
        },
      ],
    };
    queryBuilder.getOne.mockResolvedValue(room);

    await expect(service.findOne(12, 3)).resolves.toEqual({
      id: 12,
      title: '테스트 방',
      status: RoomStatus.IN_PROGRESS,
      hostId: 3,
      hostName: '방장',
      minPlayers: 2,
      maxPlayers: 6,
      currentPlayers: 2,
      isPublic: false,
      invitationCode: 'room-invite',
      players: [
        {
          memberId: 1,
          userId: 3,
          nickname: '방장',
          profileImageUrl: null,
          isReady: false,
          isHost: true,
        },
        {
          memberId: 2,
          userId: 7,
          nickname: '참여자',
          profileImageUrl: '/avatar.png',
          isReady: true,
          isHost: false,
        },
      ],
      turnSeconds: 600,
      totalRounds: 3,
      updatedAt,
    });
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      'room.members',
      'myMembership',
      expect.stringContaining('myMembership.leftAt IS NULL'),
      { userId: 3 },
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('room.id = :roomId', {
      roomId: 12,
    });
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it.each([
    RoomStatus.WAITING,
    RoomStatus.COUNTDOWN,
    RoomStatus.IN_PROGRESS,
    RoomStatus.FINISHED,
  ])('%s 상태의 활성 참여자도 방 상세를 조회할 수 있다', async (status) => {
    queryBuilder.getOne.mockResolvedValue({
      id: 12,
      status,
      members: [],
    });

    await expect(service.findOne(12, 3)).resolves.toMatchObject({
      status,
    });
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('활성 참여자가 아니면 방 상세 조회를 거부한다', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.findOne(999, 3)).rejects.toThrow(
      new ForbiddenException('참여 중인 대기실이 아닙니다.'),
    );
  });

  it('내 참여방 목록 조회는 종료된 방을 제외한다 (1인 1게임방 정책)', async () => {
    queryBuilder.getMany.mockResolvedValue([
      {
        id: 5,
        title: '진행 중인 방',
        status: RoomStatus.IN_PROGRESS,
        maxParticipants: 6,
        members: [{ id: 1 }],
      },
    ]);

    await expect(service.findMyAll(3)).resolves.toEqual([
      {
        id: 5,
        title: '진행 중인 방',
        status: RoomStatus.IN_PROGRESS,
        currentPlayers: 1,
        maxPlayers: 6,
      },
    ]);
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      'room.members',
      'myMember',
      expect.stringContaining('myMember.leftAt IS NULL'),
      { userId: 3 },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'room.status != :finishedStatus',
      { finishedStatus: RoomStatus.FINISHED },
    );
  });

  it('returns room summaries counting only active members and excluding full rooms', async () => {
    roomRepository.find.mockResolvedValue([
      {
        id: 3,
        title: '참여 가능',
        maxParticipants: 2,
        members: [{ leftAt: null }, { leftAt: new Date() }],
      },
      {
        id: 2,
        title: '정원 마감',
        maxParticipants: 2,
        members: [{ leftAt: null }, { leftAt: null }],
      },
      {
        id: 1,
        title: '빈 방',
        maxParticipants: 6,
        members: [],
      },
    ]);

    await expect(service.findAll()).resolves.toEqual([
      {
        id: 3,
        title: '참여 가능',
        status: 'WAITING',
        currentPlayers: 1,
        maxPlayers: 2,
      },
      {
        id: 1,
        title: '빈 방',
        status: 'WAITING',
        currentPlayers: 0,
        maxPlayers: 6,
      },
    ]);
    expect(roomRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: RoomStatus.WAITING, isPublic: true },
        relations: { members: true },
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
    );
  });

  it('returns an empty list when no public waiting rooms exist', async () => {
    roomRepository.find.mockResolvedValue([]);

    await expect(service.findAll()).resolves.toEqual([]);
  });

  it('returns an empty list when all rooms are full or over capacity', async () => {
    roomRepository.find.mockResolvedValue([
      {
        id: 1,
        maxParticipants: 2,
        members: [{ leftAt: null }, { leftAt: null }],
      },
      {
        id: 2,
        maxParticipants: 2,
        members: [{ leftAt: null }, { leftAt: null }, { leftAt: null }],
      },
    ]);

    await expect(service.findAll()).resolves.toEqual([]);
  });
});
