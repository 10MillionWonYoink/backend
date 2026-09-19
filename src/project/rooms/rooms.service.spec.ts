import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull } from 'typeorm';
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
    setLock: jest.fn(),
    getOne: jest.fn(),
    getMany: jest.fn(),
  };
  const roomRepository = {
    createQueryBuilder: jest.fn(),
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
  };
  const memberRepository = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const manager = {
    getRepository: (entity: typeof Room | typeof RoomMember) =>
      entity === Room ? roomRepository : memberRepository,
  };

  const dataSource = {
    getRepository: (entity: typeof Room | typeof RoomMember) =>
      entity === Room ? roomRepository : memberRepository,
    transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    queryBuilder.innerJoin.mockReturnValue(queryBuilder);
    queryBuilder.leftJoinAndSelect.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);
    queryBuilder.addOrderBy.mockReturnValue(queryBuilder);
    queryBuilder.setLock.mockReturnValue(queryBuilder);
    roomRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    memberRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    queryBuilder.getMany.mockResolvedValue([]);
    memberRepository.create.mockImplementation((input: unknown) => input);
    memberRepository.save.mockImplementation((input: unknown) =>
      Promise.resolve(input),
    );
    roomRepository.save.mockImplementation((input: unknown) =>
      Promise.resolve(input),
    );
    dataSource.transaction.mockImplementation(
      (cb: (manager: typeof manager) => unknown) => cb(manager),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: DataSource,
          useValue: dataSource,
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

  describe('leaveRoom', () => {
    const waitingRoom = {
      id: 21,
      hostId: 100,
      status: RoomStatus.WAITING,
    };

    it('마지막 참여자가 나가도 Room을 삭제하지 않고 FINISHED로 닫아서 게임 기록을 보존한다', async () => {
      roomRepository.findOne.mockResolvedValue({ ...waitingRoom });
      memberRepository.findOne.mockResolvedValue({
        roomId: 21,
        userId: 100,
        leftAt: null,
        isReady: true,
        turnOrder: null,
      });
      // 이탈 후 남은 활성 참여자 없음
      queryBuilder.getMany.mockResolvedValue([]);

      const result = await service.leaveRoom(21, 100);

      expect(roomRepository.remove).not.toHaveBeenCalled();
      expect(roomRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RoomStatus.FINISHED }),
      );
      expect(result).toEqual({
        roomId: 21,
        leftUserId: 100,
        currentParticipants: 0,
        roomDeleted: true,
        hostChanged: false,
        previousHostId: null,
        newHostId: null,
      });
    });

    it('남은 참여자가 있으면 방을 닫지 않고, 방장이었다면 가장 먼저 입장한 사람에게 방장을 넘긴다', async () => {
      roomRepository.findOne.mockResolvedValue({ ...waitingRoom });
      memberRepository.findOne.mockResolvedValue({
        roomId: 21,
        userId: 100,
        leftAt: null,
      });
      queryBuilder.getMany.mockResolvedValue([
        { userId: 101, joinedAt: new Date('2026-01-01T00:00:01Z') },
      ]);

      const result = await service.leaveRoom(21, 100);

      expect(roomRepository.remove).not.toHaveBeenCalled();
      // 방장 승계이므로 room.save는 호출되지만(hostId 갱신), status는 그대로 WAITING이어야 한다.
      expect(roomRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RoomStatus.WAITING, hostId: 101 }),
      );
      expect(result).toEqual({
        roomId: 21,
        leftUserId: 100,
        currentParticipants: 1,
        roomDeleted: false,
        hostChanged: true,
        previousHostId: 100,
        newHostId: 101,
      });
    });

    it('WAITING 상태가 아니면 나갈 수 없다', async () => {
      roomRepository.findOne.mockResolvedValue({
        ...waitingRoom,
        status: RoomStatus.IN_PROGRESS,
      });

      await expect(service.leaveRoom(21, 100)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('joinRoom', () => {
    const waitingRoom = {
      id: 14,
      status: RoomStatus.WAITING,
      maxParticipants: 2,
    };

    it('최초 참여자는 새로운 RoomMember 행을 생성한다', async () => {
      roomRepository.findOne.mockResolvedValue(waitingRoom);
      memberRepository.findOne.mockResolvedValue(null);
      memberRepository.count.mockResolvedValue(0);
      memberRepository.save.mockResolvedValue({ id: 99 });

      await expect(service.joinRoom(14, 11)).resolves.toEqual({
        message: '방에 참여했습니다.',
        roomId: 14,
        memberId: 99,
        alreadyJoined: false,
      });
      expect(memberRepository.create).toHaveBeenCalledWith({
        roomId: 14,
        userId: 11,
        isReady: false,
        turnOrder: null,
        leftAt: null,
      });
      expect(memberRepository.count).toHaveBeenCalledWith({
        where: { roomId: 14, leftAt: IsNull() },
      });
    });

    it('나갔던 사용자가 다시 참여하면 기존 행을 재사용하고 leftAt을 초기화한다 (23505 회귀 방지)', async () => {
      const existingMember = {
        id: 42,
        roomId: 14,
        userId: 11,
        isReady: true,
        turnOrder: 3,
        leftAt: new Date('2026-01-01T00:00:00Z'),
        joinedAt: new Date('2025-01-01T00:00:00Z'),
      };
      roomRepository.findOne.mockResolvedValue(waitingRoom);
      memberRepository.findOne.mockResolvedValue(existingMember);
      memberRepository.count.mockResolvedValue(0);

      const result = await service.joinRoom(14, 11);

      expect(result).toEqual({
        message: '방에 참여했습니다.',
        roomId: 14,
        memberId: 42,
        alreadyJoined: false,
      });
      // 새 행을 만들지 않고 기존 행을 재사용해야 한다 (UNIQUE(roomId, userId) 위반 방지)
      expect(memberRepository.create).not.toHaveBeenCalled();
      expect(memberRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 42,
          leftAt: null,
          isReady: false,
          turnOrder: null,
        }),
      );
    });

    it('이미 참여 중인 사용자가 다시 참여하려 하면 거부한다', async () => {
      roomRepository.findOne.mockResolvedValue(waitingRoom);
      memberRepository.findOne.mockResolvedValue({
        id: 1,
        roomId: 14,
        userId: 11,
        leftAt: null,
      });

      await expect(service.joinRoom(14, 11)).rejects.toThrow(
        new ConflictException('이미 참여 중인 방입니다.'),
      );
      expect(memberRepository.save).not.toHaveBeenCalled();
    });

    it('대기 중이 아닌 방(진행/종료)에는 재입장할 수 없다', async () => {
      roomRepository.findOne.mockResolvedValue({
        ...waitingRoom,
        status: RoomStatus.IN_PROGRESS,
      });

      await expect(service.joinRoom(14, 11)).rejects.toThrow(
        new ConflictException('대기 중인 방에만 참여할 수 있습니다.'),
      );
      expect(memberRepository.findOne).not.toHaveBeenCalled();
    });

    it('활성 참여자 수가 최대 인원 이상이면 나갔던 사용자도 재입장할 수 없다', async () => {
      roomRepository.findOne.mockResolvedValue(waitingRoom);
      memberRepository.findOne.mockResolvedValue({
        id: 42,
        roomId: 14,
        userId: 11,
        leftAt: new Date(),
      });
      // 나간 사용자를 제외한 현재 활성 인원이 이미 최대치
      memberRepository.count.mockResolvedValue(2);

      await expect(service.joinRoom(14, 11)).rejects.toThrow(
        new ConflictException('방의 최대 인원을 초과했습니다.'),
      );
      expect(memberRepository.save).not.toHaveBeenCalled();
    });
  });
});
