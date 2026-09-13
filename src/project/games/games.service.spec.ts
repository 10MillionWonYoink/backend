import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GamesService } from './games.service';
import { Room, RoomStatus } from '../rooms/entities/room.entity';
import { RoomMember } from '../rooms/entities/room-member.entity';
import { GameSession, GameStatus } from './entities/game-session.entity';
import { GameTurn, GameTurnStatus } from './entities/game-turn.entity';

describe('GamesService', () => {
  let service: GamesService;

  const roomRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };
  const memberRepository = { find: jest.fn(), findOne: jest.fn() };
  const gameRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    create: jest.fn((input: unknown) => input),
    save: jest.fn((input: unknown) => Promise.resolve(input)),
  };
  const turnRepository = {
    findOneBy: jest.fn(),
    find: jest.fn(),
    create: jest.fn((input: unknown) => input),
    save: jest.fn((input: unknown) => Promise.resolve(input)),
  };

  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === Room) return roomRepository;
      if (entity === RoomMember) return memberRepository;
      if (entity === GameSession) return gameRepository;
      if (entity === GameTurn) return turnRepository;
      throw new Error(`unexpected entity: ${String(entity)}`);
    },
  };

  const dataSource = {
    transaction: jest.fn(),
    getRepository: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    dataSource.transaction.mockImplementation(
      (cb: (manager: typeof manager) => unknown) => cb(manager),
    );
    dataSource.getRepository.mockImplementation((entity: unknown) =>
      manager.getRepository(entity),
    );
    gameRepository.create.mockImplementation((input: unknown) => input);
    gameRepository.save.mockImplementation((input: unknown) =>
      Promise.resolve(input),
    );
    turnRepository.create.mockImplementation((input: unknown) => input);
    turnRepository.save.mockImplementation((input: unknown) =>
      Promise.resolve(input),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [GamesService, { provide: DataSource, useValue: dataSource }],
    }).compile();

    service = module.get<GamesService>(GamesService);
  });

  describe('startGame', () => {
    const room = {
      id: 1,
      hostId: 10,
      status: RoomStatus.WAITING,
      minParticipants: 2,
      maxParticipants: 6,
      relayCount: 2,
      timeLimitSeconds: 60,
    };

    it('방장이 아니면 시작할 수 없다', async () => {
      roomRepository.findOne.mockResolvedValue(room);

      await expect(service.startGame(1, 999)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('준비하지 않은 참여자가 있으면 시작할 수 없다', async () => {
      roomRepository.findOne.mockResolvedValue(room);
      memberRepository.find.mockResolvedValue([
        {
          userId: 10,
          isReady: false,
          turnOrder: null,
          joinedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          userId: 11,
          isReady: false,
          turnOrder: null,
          joinedAt: new Date('2026-01-01T00:00:01Z'),
        },
      ]);

      await expect(service.startGame(1, 10)).rejects.toThrow(ConflictException);
    });

    it('참여자 순서대로 턴을 생성하고 방을 countdown 상태로 바꾼다', async () => {
      roomRepository.findOne.mockResolvedValue(room);
      memberRepository.find.mockResolvedValue([
        {
          userId: 10,
          isReady: false,
          turnOrder: null,
          joinedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          userId: 11,
          isReady: true,
          turnOrder: null,
          joinedAt: new Date('2026-01-01T00:00:01Z'),
        },
      ]);

      const result = await service.startGame(1, 10);

      expect(result.status).toBe(GameStatus.COUNTDOWN);
      expect(result.totalTurns).toBe(4); // 2명 * relayCount(2)
      expect(result.turns.map((turn) => turn.userId)).toEqual([10, 11, 10, 11]);
      expect(gameRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalTurns: 4 }),
      );
      expect(roomRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RoomStatus.COUNTDOWN }),
      );
    });
  });

  describe('submitTurn', () => {
    const game = {
      id: 5,
      roomId: 1,
      status: GameStatus.IN_PROGRESS,
      currentTurnNumber: 1,
      totalTurns: 2,
      timeLimitSeconds: 60,
    };

    it('현재 차례가 아닌 사용자는 제출할 수 없다', async () => {
      gameRepository.findOne.mockResolvedValue({ ...game });
      turnRepository.findOneBy.mockResolvedValue({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.submitTurn(5, 999, 'key.jpg')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('마지막 턴이 아니면 다음 턴을 시작시킨다', async () => {
      gameRepository.findOne.mockResolvedValue({ ...game });
      turnRepository.findOneBy
        .mockResolvedValueOnce({
          gameSessionId: 5,
          turnNumber: 1,
          userId: 10,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .mockResolvedValueOnce({
          gameSessionId: 5,
          turnNumber: 2,
          userId: 11,
        });

      const result = await service.submitTurn(5, 10, 'key-1.jpg');

      expect(result.finished).toBe(false);
      expect(result.submittedTurn).toEqual({
        turnNumber: 1,
        userId: 10,
        imageKey: 'key-1.jpg',
      });
      expect(result.nextTurn?.turnNumber).toBe(2);
      expect(result.nextTurn?.userId).toBe(11);
      expect(roomRepository.update).not.toHaveBeenCalled();
    });

    it('마지막 턴이면 게임과 방을 종료 상태로 만든다', async () => {
      gameRepository.findOne.mockResolvedValue({
        ...game,
        currentTurnNumber: 2,
      });
      turnRepository.findOneBy.mockResolvedValue({
        gameSessionId: 5,
        turnNumber: 2,
        userId: 11,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.submitTurn(5, 11, 'key-2.jpg');

      expect(result.finished).toBe(true);
      expect(result.nextTurn).toBeNull();
      expect(roomRepository.update).toHaveBeenCalledWith(1, {
        status: RoomStatus.FINISHED,
      });
    });

    it('제한 시간이 지나면 제출을 거부한다', async () => {
      gameRepository.findOne.mockResolvedValue({ ...game });
      turnRepository.findOneBy.mockResolvedValue({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.submitTurn(5, 10, 'key.jpg')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('expireCurrentTurn', () => {
    it('이미 제출된 턴이면 아무 것도 하지 않는다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 1,
        totalTurns: 2,
        timeLimitSeconds: 60,
      });
      turnRepository.findOneBy.mockResolvedValue({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        status: GameTurnStatus.SUBMITTED,
      });

      const result = await service.expireCurrentTurn(5);

      expect(result).toBeNull();
      expect(turnRepository.save).not.toHaveBeenCalled();
    });

    it('진행 중인 게임이 아니면 null을 반환한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        status: GameStatus.FINISHED,
      });

      const result = await service.expireCurrentTurn(5);

      expect(result).toBeNull();
    });

    it('제한 시간이 지난 턴을 만료시키고 다음 턴을 시작한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 1,
        totalTurns: 2,
        timeLimitSeconds: 60,
      });
      turnRepository.findOneBy
        .mockResolvedValueOnce({
          gameSessionId: 5,
          turnNumber: 1,
          userId: 10,
          status: GameTurnStatus.IN_PROGRESS,
          expiresAt: new Date(Date.now() - 1_000),
        })
        .mockResolvedValueOnce({
          gameSessionId: 5,
          turnNumber: 2,
          userId: 11,
        });

      const result = await service.expireCurrentTurn(5);

      expect(result?.expiredTurn).toEqual({ turnNumber: 1, userId: 10 });
      expect(result?.nextTurn?.turnNumber).toBe(2);
      expect(turnRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameTurnStatus.EXPIRED }),
      );
    });
  });

  describe('getSessionState / getResult / findLatestGameByRoom', () => {
    it('방 참여자가 아니면 세션 조회를 거부한다', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({ id: 5, roomId: 1 }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue(null) };
        }
        throw new Error('unexpected');
      });

      await expect(service.getSessionState(5, 999)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('존재하지 않는 게임은 조회할 수 없다', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return { findOneBy: jest.fn().mockResolvedValue(null) };
        }
        throw new Error('unexpected');
      });

      await expect(service.getSessionState(999, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('종료되지 않은 게임의 결과는 조회할 수 없다', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.IN_PROGRESS,
            }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        throw new Error('unexpected');
      });

      await expect(service.getResult(5, 1)).rejects.toThrow(ConflictException);
    });

    it('가장 최근 게임을 조회한다', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        if (entity === GameSession) {
          return {
            findOne: jest.fn().mockResolvedValue({
              id: 7,
              roomId: 1,
              status: GameStatus.FINISHED,
              countdownEndsAt: null,
              currentTurnNumber: 4,
              totalTurns: 4,
            }),
          };
        }
        throw new Error('unexpected');
      });

      const result = await service.findLatestGameByRoom(1, 1);

      expect(result).toEqual({
        gameId: 7,
        roomId: 1,
        status: GameStatus.FINISHED,
        countdownEndsAt: null,
        currentTurnNumber: 4,
        totalTurns: 4,
      });
    });
  });
});
