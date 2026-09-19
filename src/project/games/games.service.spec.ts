import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GamesService } from './games.service';
import { Room, RoomStatus } from '../rooms/entities/room.entity';
import { RoomMember } from '../rooms/entities/room-member.entity';
import { GameSession, GameStatus } from './entities/game-session.entity';
import {
  GameTurn,
  GameTurnEvaluationStatus,
  GameTurnStatus,
} from './entities/game-turn.entity';
import { GeminiService } from '../ai/gemini.service';
import { GeminiApiError } from '../ai/gemini.errors';
import { UploadsService } from '../uploads/uploads.service';

// GamesService의 fire-and-forget AI 처리(배치 Topic/평가)는 public API가 아니므로,
// 테스트에서만 타입 안전하게 접근하기 위한 헬퍼.
interface GamesServiceInternals {
  runGameEvaluation: (gameId: number) => Promise<void>;
  evaluateGameInBackground: (gameId: number) => void;
  estimateTotalTurns: (roomId: number) => Promise<number>;
  generateTopicsSafely: (count: number) => Promise<string[]>;
}

function internals(service: GamesService): GamesServiceInternals {
  return service as unknown as GamesServiceInternals;
}

describe('GamesService', () => {
  let service: GamesService;

  const roomRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };
  const memberRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    count: jest.fn(),
  };
  const gameRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    create: jest.fn((input: unknown) => input),
    save: jest.fn((input: unknown) => Promise.resolve(input)),
  };
  const turnRepository = {
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((input: unknown) => input),
    save: jest.fn((input: unknown) => Promise.resolve(input)),
    update: jest.fn(),
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

  const geminiService = {
    generateTopics: jest.fn(),
    evaluatePhotosBatch: jest.fn(),
  };
  const uploadsService = {
    verifyUploadedImage: jest.fn(),
    createImageReadUrl: jest.fn(),
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
    turnRepository.update.mockResolvedValue({ affected: 1 });
    turnRepository.find.mockResolvedValue([]);

    // 기본값: AI가 설정되어 있지 않은 것처럼 실패시켜, 기존(비AI) 테스트들이
    // "AI 실패가 게임 진행에 영향을 주지 않는다"를 자연스럽게 함께 검증하게 한다.
    geminiService.generateTopics.mockRejectedValue(
      new GeminiApiError('GEMINI_API_KEY가 설정되지 않았습니다.'),
    );
    geminiService.evaluatePhotosBatch.mockRejectedValue(
      new GeminiApiError('GEMINI_API_KEY가 설정되지 않았습니다.'),
    );

    uploadsService.verifyUploadedImage.mockResolvedValue(undefined);
    uploadsService.createImageReadUrl.mockResolvedValue(
      'https://example.com/signed-read-url',
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GamesService,
        { provide: DataSource, useValue: dataSource },
        { provide: GeminiService, useValue: geminiService },
        { provide: UploadsService, useValue: uploadsService },
      ],
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

    beforeEach(() => {
      // estimateTotalTurns()가 트랜잭션 진입 전에 먼저 조회하는 값들의 기본값.
      // (실제 검증은 트랜잭션 내부 로직이 담당하므로, 여기서는 대략적인 값이면 충분하다.)
      roomRepository.findOneBy.mockResolvedValue(room);
      memberRepository.count.mockResolvedValue(2);
    });

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
      // startGame()이 room.status를 직접 변경하므로, 이후 테스트에 영향이
      // 새지 않도록 공유 fixture가 아닌 복사본을 전달한다.
      roomRepository.findOne.mockResolvedValue({ ...room });
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
      // 이 테스트는 beforeEach의 기본값(Gemini 미설정/실패)으로 실행된다:
      // Topic 생성이 실패해도 게임 시작 자체는 그대로 성공해야 한다.
      expect(result.topic).toBeNull();
    });

    it('Topic 배치 생성이 성공하면 게임당 1회 호출로 각 턴에 서로 다른 topic을 배정한다', async () => {
      // startGame()이 방 객체(room.status)를 직접 변경하므로,
      // 다른 테스트와 공유되는 참조가 아닌 복사본을 사용한다.
      roomRepository.findOne.mockResolvedValue({ ...room });
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
      geminiService.generateTopics.mockResolvedValue({
        topics: ['주제1', '주제2', '주제3', '주제4'],
      });

      const result = await service.startGame(1, 10);

      // 세션 topic은 배치로 만든 첫 topic을 재사용한다 (별도 호출 없음).
      expect(result.topic).toBe('주제1');
      expect(gameRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ topic: '주제1' }),
      );
      // 4턴(2명 × relayCount 2) 각각에 순서대로 topic이 배정된다.
      expect(turnRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({ turnNumber: 1, topic: '주제1' }),
        expect.objectContaining({ turnNumber: 2, topic: '주제2' }),
        expect.objectContaining({ turnNumber: 3, topic: '주제3' }),
        expect.objectContaining({ turnNumber: 4, topic: '주제4' }),
      ]);
      // 게임 시작 시 Topic 생성 Gemini 호출은 정확히 1회여야 한다 (턴마다 호출 아님).
      expect(geminiService.generateTopics).toHaveBeenCalledTimes(1);
    });

    it('Topic 배치 생성 호출 자체가 실패해도 게임 시작에는 영향이 없다', async () => {
      roomRepository.findOne.mockResolvedValue({ ...room });
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
      geminiService.generateTopics.mockRejectedValue(new Error('network'));

      await expect(service.startGame(1, 10)).resolves.toEqual(
        expect.objectContaining({ status: GameStatus.COUNTDOWN, topic: null }),
      );
    });

    it('배치로 생성된 topic 수가 실제 턴 수보다 적으면, 모자란 턴은 topic: null로 남는다', async () => {
      roomRepository.findOne.mockResolvedValue({ ...room });
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
      // 4턴이 필요하지만(2명 × relayCount 2) topic은 2개만 돌아온 경우
      geminiService.generateTopics.mockResolvedValue({
        topics: ['주제1', '주제2'],
      });

      await service.startGame(1, 10);

      expect(turnRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({ turnNumber: 1, topic: '주제1' }),
        expect.objectContaining({ turnNumber: 2, topic: '주제2' }),
        expect.objectContaining({ turnNumber: 3, topic: null }),
        expect.objectContaining({ turnNumber: 4, topic: null }),
      ]);
    });
  });

  describe('beginFirstTurn', () => {
    it('첫 턴을 시작시키고, 해당 턴의 개인 Topic 생성을 백그라운드로 트리거한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.COUNTDOWN,
        timeLimitSeconds: 60,
      });
      turnRepository.findOne.mockResolvedValue({
        turnNumber: 1,
        userId: 10,
        // 게임 시작 시 배치로 미리 배정된 topic (턴 시작 시점에 별도로 생성하지 않는다).
        topic: '주제1',
      });

      const result = await service.beginFirstTurn(5);

      expect(result).toEqual(
        expect.objectContaining({
          gameId: 5,
          roomId: 1,
          turnNumber: 1,
          userId: 10,
        }),
      );
      // 카운트다운 중 이탈로 1번 턴이 스킵됐을 수 있으므로, turnNumber 고정이 아니라
      // "가장 이른 WAITING 턴"을 찾는다.
      expect(turnRepository.findOne).toHaveBeenCalledWith({
        where: { gameSessionId: 5, status: GameTurnStatus.WAITING },
        order: { turnNumber: 'ASC' },
      });
    });

    it('중복 실행 방지로 null을 반환한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        status: GameStatus.IN_PROGRESS,
      });

      const result = await service.beginFirstTurn(5);

      expect(result).toBeNull();
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
      topic: null as string | null,
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
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        expiresAt: new Date(Date.now() + 60_000),
      });
      turnRepository.findOne.mockResolvedValueOnce({
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
        imageUrl: 'https://example.com/signed-read-url',
      });
      expect(result.nextTurn?.turnNumber).toBe(2);
      expect(result.nextTurn?.userId).toBe(11);
      expect(roomRepository.update).not.toHaveBeenCalled();
    });

    it('게임이 끝나지 않은 제출은 배치 평가를 트리거하지 않는다 (게임 종료 후에만 채점한다)', async () => {
      gameRepository.findOne.mockResolvedValue({ ...game });
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        expiresAt: new Date(Date.now() + 60_000),
      });
      turnRepository.findOne.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 2,
        userId: 11,
      });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      await service.submitTurn(5, 10, 'key-1.jpg');

      expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('마지막 턴 제출로 게임이 끝나면 방을 종료 상태로 만들고 배치 평가를 트리거한다', async () => {
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
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      const result = await service.submitTurn(5, 11, 'key-2.jpg');

      expect(result.finished).toBe(true);
      expect(result.nextTurn).toBeNull();
      expect(roomRepository.update).toHaveBeenCalledWith(1, {
        status: RoomStatus.FINISHED,
      });
      expect(evaluateSpy).toHaveBeenCalledWith(5);
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

    it('제한 시간이 지난 턴을 만료시키고 다음 턴을 시작하며, 배치 평가는 트리거하지 않는다 (게임이 안 끝났으므로)', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 1,
        totalTurns: 2,
        timeLimitSeconds: 60,
      });
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        status: GameTurnStatus.IN_PROGRESS,
        expiresAt: new Date(Date.now() - 1_000),
      });
      turnRepository.findOne.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 2,
        userId: 11,
      });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      const result = await service.expireCurrentTurn(5);

      expect(result?.expiredTurn).toEqual({ turnNumber: 1, userId: 10 });
      expect(result?.nextTurn?.turnNumber).toBe(2);
      expect(turnRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameTurnStatus.EXPIRED }),
      );
      expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('만료로 게임이 종료되면 배치 평가를 트리거한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 2,
        totalTurns: 2,
        timeLimitSeconds: 60,
      });
      turnRepository.findOneBy.mockResolvedValue({
        gameSessionId: 5,
        turnNumber: 2,
        userId: 11,
        status: GameTurnStatus.IN_PROGRESS,
        expiresAt: new Date(Date.now() - 1_000),
      });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      const result = await service.expireCurrentTurn(5);

      expect(result?.finished).toBe(true);
      expect(evaluateSpy).toHaveBeenCalledWith(5);
    });
  });

  describe('leaveActiveGame (게임 진행 중 이탈)', () => {
    it('게임을 찾을 수 없으면 거부한다', async () => {
      gameRepository.findOne.mockResolvedValue(null);

      await expect(service.leaveActiveGame(5, 10)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('이미 종료되었거나 취소된 게임이면 거부한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.FINISHED,
      });

      await expect(service.leaveActiveGame(5, 10)).rejects.toThrow(
        ConflictException,
      );
      expect(roomRepository.findOne).not.toHaveBeenCalled();
    });

    it('현재 방에 참여 중인 사용자가 아니면 거부한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 1,
      });
      roomRepository.findOne.mockResolvedValue({ id: 1 });
      memberRepository.findOne.mockResolvedValue(null);

      await expect(service.leaveActiveGame(5, 999)).rejects.toThrow(
        BadRequestException,
      );
      expect(gameRepository.save).not.toHaveBeenCalled();
    });

    it('남은 인원이 2명 이상이면 이탈자의 WAITING 턴만 EXPIRED로 건너뛰고 게임을 계속 진행한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
        totalTurns: 9,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 10,
        leftAt: null,
        isReady: true,
        turnOrder: 1,
      });
      memberRepository.count.mockResolvedValue(2);
      // 이탈한 사용자(10)가 현재(3번) 턴의 당사자
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 3,
        userId: 10,
        status: GameTurnStatus.IN_PROGRESS,
      });
      // advanceTurn이 찾는 다음 턴
      turnRepository.findOne.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 4,
        userId: 11,
      });

      const result = await service.leaveActiveGame(5, 10);

      const leftAtMatcher: unknown = expect.any(Date);

      expect(memberRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 10,
          isReady: false,
          turnOrder: null,
          leftAt: leftAtMatcher,
        }),
      );
      // 이탈자의 미진행 턴 스킵 (턴 번호/구조는 그대로, EXPIRED만 마킹)
      expect(turnRepository.update).toHaveBeenCalledWith(
        { gameSessionId: 5, userId: 10, status: GameTurnStatus.WAITING },
        { status: GameTurnStatus.EXPIRED },
      );
      // 현재 턴(3번)이 이탈자 것이었으므로 만료 처리 후 다음 턴(4번)으로 진행
      expect(turnRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          turnNumber: 3,
          status: GameTurnStatus.EXPIRED,
        }),
      );
      // 게임 전체는 취소/종료되지 않는다
      expect(gameRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: GameStatus.FINISHED }),
      );
      expect(roomRepository.save).not.toHaveBeenCalled();
      expect(roomRepository.update).not.toHaveBeenCalled();

      const nextTurnMatcher: unknown = expect.objectContaining({
        turnNumber: 4,
        userId: 11,
      });

      expect(result).toEqual({
        finished: false,
        gameId: 5,
        roomId: 1,
        leftUserId: 10,
        remainingParticipants: 2,
        turnAdvance: {
          finished: false,
          gameId: 5,
          roomId: 1,
          nextTurn: nextTurnMatcher,
        },
      });
    });

    it('이탈자가 현재 턴 당사자가 아니면 진행 중인 턴은 그대로 두고 이탈만 처리한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
        totalTurns: 9,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 12,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(3);
      // 현재(3번) 턴의 당사자는 이탈자(12)가 아니라 다른 사용자(10)
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 3,
        userId: 10,
        status: GameTurnStatus.IN_PROGRESS,
      });

      const result = await service.leaveActiveGame(5, 12);

      // 현재 턴을 건드리지 않으므로 advanceTurn(=turnRepository.findOne)까지 가지 않는다
      expect(turnRepository.findOne).not.toHaveBeenCalled();
      expect(turnRepository.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        finished: false,
        gameId: 5,
        roomId: 1,
        leftUserId: 12,
        remainingParticipants: 3,
        turnAdvance: null,
      });
    });

    it('COUNTDOWN 단계(아직 턴이 시작되지 않음)에서 이탈하면 진행할 턴이 없으므로 스킵만 처리한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 6,
        roomId: 2,
        status: GameStatus.COUNTDOWN,
        currentTurnNumber: 0,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 2,
        status: RoomStatus.COUNTDOWN,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 2,
        userId: 20,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(2);

      const result = await service.leaveActiveGame(6, 20);

      expect(turnRepository.update).toHaveBeenCalledWith(
        { gameSessionId: 6, userId: 20, status: GameTurnStatus.WAITING },
        { status: GameTurnStatus.EXPIRED },
      );
      expect(result.turnAdvance).toBeNull();
      expect(result.finished).toBe(false);
    });

    it('남은 인원이 1명 이하가 되면 진행 중이던 턴을 정리하고 즉시 FINISHED 처리한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
        totalTurns: 6,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 10,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(1);

      const result = await service.leaveActiveGame(5, 10);

      // 진행 중이던 3번 턴 정리
      expect(turnRepository.update).toHaveBeenCalledWith(
        {
          gameSessionId: 5,
          turnNumber: 3,
          status: GameTurnStatus.IN_PROGRESS,
        },
        { status: GameTurnStatus.EXPIRED },
      );
      // finishGame: 정상 종료와 동일하게 FINISHED 재사용 (CANCELLED 아님)
      expect(gameRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameStatus.FINISHED }),
      );
      expect(roomRepository.update).toHaveBeenCalledWith(1, {
        status: RoomStatus.FINISHED,
      });
      expect(result).toEqual({
        finished: true,
        gameId: 5,
        roomId: 1,
        leftUserId: 10,
        remainingParticipants: 1,
        turnAdvance: null,
      });
    });

    it('COUNTDOWN 중 남은 인원이 1명 이하가 되어도 즉시 FINISHED 처리한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 6,
        roomId: 2,
        status: GameStatus.COUNTDOWN,
        currentTurnNumber: 0,
        totalTurns: 4,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 2,
        status: RoomStatus.COUNTDOWN,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 2,
        userId: 20,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(0);

      const result = await service.leaveActiveGame(6, 20);

      expect(gameRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameStatus.FINISHED }),
      );
      expect(result.finished).toBe(true);
      expect(result.remainingParticipants).toBe(0);
    });

    it('인원 부족으로 즉시 종료되면 배치 평가를 트리거한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
        totalTurns: 6,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 10,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(1);
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      await service.leaveActiveGame(5, 10);

      expect(evaluateSpy).toHaveBeenCalledWith(5);
    });

    it('게임이 계속되면(잔여 인원 충분) 배치 평가를 트리거하지 않는다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
        totalTurns: 9,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 12,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(3);
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 3,
        userId: 10,
        status: GameTurnStatus.IN_PROGRESS,
      });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      await service.leaveActiveGame(5, 12);

      expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('이탈자의 마지막 턴 진행으로 게임이 자연 종료되면(잔여 인원은 충분해도) 배치 평가를 트리거한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 9,
        totalTurns: 9,
        timeLimitSeconds: 60,
      });
      roomRepository.findOne.mockResolvedValue({
        id: 1,
        status: RoomStatus.IN_PROGRESS,
      });
      memberRepository.findOne.mockResolvedValue({
        roomId: 1,
        userId: 10,
        leftAt: null,
      });
      memberRepository.count.mockResolvedValue(2);
      // 이탈자(10)가 마지막(9번) 턴의 당사자 - 만료 처리 후 advanceTurn이 다음 턴을
      // 찾지 못해(turnRepository.find가 undefined 반환) 자연 종료된다.
      turnRepository.findOneBy.mockResolvedValueOnce({
        gameSessionId: 5,
        turnNumber: 9,
        userId: 10,
        status: GameTurnStatus.IN_PROGRESS,
      });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateGameInBackground')
        .mockImplementation(() => {});

      const result = await service.leaveActiveGame(5, 10);

      expect(result.finished).toBe(false);
      expect(result.turnAdvance?.finished).toBe(true);
      expect(evaluateSpy).toHaveBeenCalledWith(5);
    });
  });

  describe('findResumableSessions (서버 재시작 후 타이머 복구용)', () => {
    it('진행 중인 게임이 없으면 빈 배열을 반환한다', async () => {
      gameRepository.find.mockResolvedValue([]);

      await expect(service.findResumableSessions()).resolves.toEqual([]);
      expect(turnRepository.findOneBy).not.toHaveBeenCalled();
    });

    it('COUNTDOWN 상태 게임은 countdown 단계로 반환한다', async () => {
      const countdownEndsAt = new Date('2026-01-01T00:00:03Z');
      gameRepository.find.mockResolvedValue([
        {
          id: 1,
          status: GameStatus.COUNTDOWN,
          countdownEndsAt,
          currentTurnNumber: 0,
        },
      ]);

      await expect(service.findResumableSessions()).resolves.toEqual([
        { gameId: 1, phase: 'countdown', countdownEndsAt },
      ]);
    });

    it('IN_PROGRESS 상태 게임은 현재 턴의 expiresAt과 함께 turn 단계로 반환한다', async () => {
      const expiresAt = new Date('2026-01-01T00:01:00Z');
      gameRepository.find.mockResolvedValue([
        { id: 2, status: GameStatus.IN_PROGRESS, currentTurnNumber: 3 },
      ]);
      turnRepository.findOneBy.mockResolvedValue({
        turnNumber: 3,
        status: GameTurnStatus.IN_PROGRESS,
        expiresAt,
      });

      await expect(service.findResumableSessions()).resolves.toEqual([
        { gameId: 2, phase: 'turn', turnNumber: 3, expiresAt },
      ]);
      expect(turnRepository.findOneBy).toHaveBeenCalledWith({
        gameSessionId: 2,
        turnNumber: 3,
      });
    });

    it('현재 턴이 이미 SUBMITTED/EXPIRED로 처리된(경합) 경우는 제외한다', async () => {
      gameRepository.find.mockResolvedValue([
        { id: 3, status: GameStatus.IN_PROGRESS, currentTurnNumber: 1 },
      ]);
      turnRepository.findOneBy.mockResolvedValue({
        turnNumber: 1,
        status: GameTurnStatus.SUBMITTED,
        expiresAt: new Date(),
      });

      await expect(service.findResumableSessions()).resolves.toEqual([]);
    });
  });

  describe('runGameEvaluation (게임 종료 후 배치 AI 채점)', () => {
    function turnFixture(overrides: Record<string, unknown> = {}) {
      return {
        id: 101,
        gameSessionId: 5,
        turnNumber: 1,
        userId: 10,
        status: GameTurnStatus.SUBMITTED,
        aiEvaluationStatus: GameTurnEvaluationStatus.PENDING,
        imageKey: 'key.jpg',
        topic: '오늘의 하늘',
        ...overrides,
      };
    }

    it('평가할 SUBMITTED+PENDING 턴이 없으면 아무 것도 하지 않는다', async () => {
      turnRepository.find.mockResolvedValue([]);

      await internals(service).runGameEvaluation(5);

      expect(geminiService.evaluatePhotosBatch).not.toHaveBeenCalled();
      expect(turnRepository.update).not.toHaveBeenCalled();
    });

    it('사진 여러 장을 1회의 배치 호출로 채점하고, 점수는 backend에서 합산해 저장한다', async () => {
      turnRepository.find.mockResolvedValue([
        turnFixture({ id: 101, topic: '주제1' }),
        turnFixture({ id: 102, topic: '주제2' }),
      ]);
      geminiService.evaluatePhotosBatch.mockResolvedValue([
        {
          turnIndex: 1,
          relevance: 42,
          expression: 25,
          creativity: 16,
          feedback: '좋아요',
        },
        {
          turnIndex: 2,
          relevance: 30,
          expression: 20,
          creativity: 10,
          feedback: '괜찮아요',
        },
      ]);

      await internals(service).runGameEvaluation(5);

      // 사진 2장이어도 Gemini 호출은 1회(청크 크기 이내)
      expect(geminiService.evaluatePhotosBatch).toHaveBeenCalledTimes(1);
      expect(turnRepository.update).toHaveBeenCalledWith(
        101,
        expect.objectContaining({
          aiScore: 83, // 42 + 25 + 16 (Gemini가 아닌 backend가 합산)
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        }),
      );
      expect(turnRepository.update).toHaveBeenCalledWith(
        102,
        expect.objectContaining({
          aiScore: 60, // 30 + 20 + 10
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        }),
      );
    });

    it('topic이 없는 턴은 평가 대상에서 제외하고 즉시 FAILED로 남긴다', async () => {
      turnRepository.find.mockResolvedValue([
        turnFixture({ id: 101, topic: null }),
      ]);

      await internals(service).runGameEvaluation(5);

      expect(geminiService.evaluatePhotosBatch).not.toHaveBeenCalled();
      expect(turnRepository.update).toHaveBeenCalledWith([101], {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });

    it('청크 크기(10)를 넘으면 여러 번 나눠 호출한다', async () => {
      const turns = Array.from({ length: 12 }, (_, index) =>
        turnFixture({ id: 200 + index }),
      );
      turnRepository.find.mockResolvedValue(turns);
      const chunkSizes: number[] = [];

      geminiService.evaluatePhotosBatch.mockImplementation(
        (items: { turnIndex: number }[]) => {
          chunkSizes.push(items.length);

          return Promise.resolve(
            items.map((item) => ({
              turnIndex: item.turnIndex,
              relevance: 10,
              expression: 10,
              creativity: 10,
              feedback: '피드백',
            })),
          );
        },
      );

      await internals(service).runGameEvaluation(5);

      expect(geminiService.evaluatePhotosBatch).toHaveBeenCalledTimes(2);
      expect(chunkSizes).toEqual([10, 2]);
    });

    it('배치 호출 자체가 실패해도 예외를 던지지 않고, 해당 청크는 FAILED로 남긴다', async () => {
      turnRepository.find.mockResolvedValue([
        turnFixture({ id: 101 }),
        turnFixture({ id: 102 }),
      ]);
      geminiService.evaluatePhotosBatch.mockRejectedValue(
        new GeminiApiError('사진 평가 요청에 실패했습니다.'),
      );

      await expect(
        internals(service).runGameEvaluation(5),
      ).resolves.toBeUndefined();

      expect(turnRepository.update).toHaveBeenCalledWith([101, 102], {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });

    it('응답에 없는(누락된) turnIndex는 FAILED로 남긴다', async () => {
      turnRepository.find.mockResolvedValue([
        turnFixture({ id: 101 }),
        turnFixture({ id: 102 }),
      ]);
      geminiService.evaluatePhotosBatch.mockResolvedValue([
        {
          turnIndex: 1,
          relevance: 10,
          expression: 10,
          creativity: 10,
          feedback: '피드백',
        },
        // turnIndex 2(=turnId 102)는 응답에서 누락됨
      ]);

      await internals(service).runGameEvaluation(5);

      expect(turnRepository.update).toHaveBeenCalledWith(
        101,
        expect.objectContaining({
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        }),
      );
      expect(turnRepository.update).toHaveBeenCalledWith([102], {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });
  });

  describe('estimateTotalTurns / generateTopicsSafely (Topic 배치 생성 준비)', () => {
    it('estimateTotalTurns는 활성 참여자 수 × relayCount를 반환한다', async () => {
      roomRepository.findOneBy.mockResolvedValue({ relayCount: 3 });
      memberRepository.count.mockResolvedValue(4);

      await expect(internals(service).estimateTotalTurns(1)).resolves.toBe(12);
    });

    it('estimateTotalTurns는 방이 없으면 NotFoundException을 던진다', async () => {
      roomRepository.findOneBy.mockResolvedValue(null);

      await expect(internals(service).estimateTotalTurns(1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('generateTopicsSafely는 성공하면 topics 배열을 반환한다', async () => {
      geminiService.generateTopics.mockResolvedValue({
        topics: ['주제1', '주제2'],
      });

      await expect(internals(service).generateTopicsSafely(2)).resolves.toEqual(
        ['주제1', '주제2'],
      );
    });

    it('generateTopicsSafely는 실패해도 예외를 던지지 않고 빈 배열을 반환한다', async () => {
      geminiService.generateTopics.mockRejectedValue(new Error('network'));

      await expect(internals(service).generateTopicsSafely(2)).resolves.toEqual(
        [],
      );
    });

    it('generateTopicsSafely는 count가 0 이하면 Gemini를 호출하지 않는다', async () => {
      await expect(internals(service).generateTopicsSafely(0)).resolves.toEqual(
        [],
      );
      expect(geminiService.generateTopics).not.toHaveBeenCalled();
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

    it('참여자 이탈로 조기 종료(FINISHED)된 게임도 결과 조회는 허용한다 (남은 참여자가 진행 상황을 확인할 수 있도록)', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.FINISHED,
              topic: null,
              totalTurns: 4,
              startedAt: new Date(),
              finishedAt: new Date(),
            }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        if (entity === Room) {
          return { findOneBy: jest.fn().mockResolvedValue({ title: '방' }) };
        }
        if (entity === GameTurn) {
          return { find: jest.fn().mockResolvedValue([]) };
        }
        throw new Error('unexpected');
      });

      const result = await service.getResult(5, 1);

      expect(result.status).toBe(GameStatus.FINISHED);
      expect(result.ranking).toEqual([]);
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

    it('진행 중인 턴의 개인 Topic은 그 턴 당사자에게만 노출하고, 다른 참여자에게는 숨긴다', async () => {
      const currentTurnFixture = {
        turnNumber: 3,
        userId: 10,
        user: { nickname: '수연' },
        status: GameTurnStatus.IN_PROGRESS,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-01-01T00:01:00Z'),
        topic: '파란색 물건 찾아 찍기',
      };

      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.IN_PROGRESS,
              topic: null,
              currentTurnNumber: 3,
              totalTurns: 6,
              timeLimitSeconds: 60,
            }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        if (entity === GameTurn) {
          return { find: jest.fn().mockResolvedValue([currentTurnFixture]) };
        }
        throw new Error('unexpected');
      });

      const ownResult = await service.getSessionState(5, 10);

      expect(ownResult.currentTurn?.topic).toBe('파란색 물건 찾아 찍기');

      const otherResult = await service.getSessionState(5, 99);

      expect(otherResult.currentTurn?.topic).toBeNull();
      // 나머지 currentTurn 정보(턴 번호, 누구 차례인지 등)는 그대로 보여도 된다.
      expect(otherResult.currentTurn?.turnNumber).toBe(3);
      expect(otherResult.currentTurn?.userId).toBe(10);
    });

    it('게임 결과에 topic, 턴별 score/feedback, 참가자별 평균점수·순위를 포함한다 (동점은 공동 순위, 제출 수가 달라도 평균으로 공정하게 비교)', async () => {
      const turns = [
        {
          turnNumber: 1,
          userId: 10,
          user: { nickname: '수연', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'a.jpg',
          submittedAt: new Date('2026-01-01T00:00:01Z'),
          topic: '주변에서 웃는 얼굴처럼 보이는 물건 찾아 찍기',
          aiScore: 90,
          aiFeedback: '좋아요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          turnNumber: 2,
          userId: 11,
          user: { nickname: '민준', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'b.jpg',
          submittedAt: new Date('2026-01-01T00:00:02Z'),
          aiScore: 60,
          aiFeedback: '아쉬워요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          turnNumber: 3,
          userId: 10,
          user: { nickname: '수연', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'c.jpg',
          submittedAt: new Date('2026-01-01T00:00:03Z'),
          aiScore: 70,
          aiFeedback: '보통이에요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          turnNumber: 4,
          userId: 11,
          user: { nickname: '민준', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'd.jpg',
          submittedAt: new Date('2026-01-01T00:00:04Z'),
          aiScore: 100,
          aiFeedback: '멋져요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          // 이탈 없이 참여했지만 제출 1건뿐인 참가자: 총점(sum) 기준이라면 불리하지만
          // 평균 기준이므로 2건 제출한 참가자들과 공정하게 비교된다.
          turnNumber: 5,
          userId: 12,
          user: { nickname: '지훈', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'e.jpg',
          submittedAt: new Date('2026-01-01T00:00:05Z'),
          aiScore: 70,
          aiFeedback: '괜찮아요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          // 시간 초과로 미제출된 턴: 임의로 점수를 만들어내지 않고 0으로 취급한다.
          turnNumber: 6,
          userId: 12,
          user: { nickname: '지훈', profileImageUrl: null },
          status: GameTurnStatus.EXPIRED,
          imageKey: null,
          submittedAt: null,
          aiScore: null,
          aiFeedback: null,
          aiEvaluationStatus: GameTurnEvaluationStatus.PENDING,
        },
      ];

      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.FINISHED,
              topic: '오늘의 하늘',
              totalTurns: 6,
              startedAt: new Date('2026-01-01T00:00:00Z'),
              finishedAt: new Date('2026-01-01T00:10:00Z'),
            }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        if (entity === Room) {
          return {
            findOneBy: jest.fn().mockResolvedValue({ title: '테스트 방' }),
          };
        }
        if (entity === GameTurn) {
          return { find: jest.fn().mockResolvedValue(turns) };
        }
        throw new Error('unexpected');
      });

      const result = await service.getResult(5, 1);

      expect(result.topic).toBe('오늘의 하늘');
      expect(result.evaluationComplete).toBe(true);
      expect(result.turns[0]).toEqual(
        expect.objectContaining({
          turnNumber: 1,
          // 게임 종료 후에는 모든 참가자의 개인(턴별) Topic이 공개되어야 한다.
          topic: '주변에서 웃는 얼굴처럼 보이는 물건 찾아 찍기',
          score: 90,
          feedback: '좋아요',
        }),
      );
      expect(result.turns[5]).toEqual(
        expect.objectContaining({
          turnNumber: 6,
          status: GameTurnStatus.EXPIRED,
          score: null,
          feedback: null,
        }),
      );
      // 기존 필드도 그대로 유지되어야 한다 (회귀 방지).
      expect(result).toEqual(
        expect.objectContaining({
          gameId: 5,
          roomId: 1,
          roomTitle: '테스트 방',
          status: GameStatus.FINISHED,
          totalTurns: 6,
        }),
      );

      // 수연 평균(90+70)/2=80 == 민준 평균(60+100)/2=80 > 지훈 평균 70/1=70(1건 제출)
      // : 표준 경쟁 순위(1,1,3). totalScore는 필드명 그대로지만 값은 평균이다.
      expect(result.ranking).toEqual([
        { userId: 10, nickname: '수연', totalScore: 80, rank: 1 },
        { userId: 11, nickname: '민준', totalScore: 80, rank: 1 },
        { userId: 12, nickname: '지훈', totalScore: 70, rank: 3 },
      ]);
    });

    it('AI 채점이 아직 끝나지 않은 제출 턴이 있으면 evaluationComplete=false를 반환한다', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.FINISHED,
              topic: '오늘의 하늘',
              totalTurns: 1,
              startedAt: new Date(),
              finishedAt: new Date(),
            }),
          };
        }
        if (entity === RoomMember) {
          return { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
        }
        if (entity === Room) {
          return { findOneBy: jest.fn().mockResolvedValue(null) };
        }
        if (entity === GameTurn) {
          return {
            find: jest.fn().mockResolvedValue([
              {
                turnNumber: 1,
                userId: 10,
                user: { nickname: '수연', profileImageUrl: null },
                status: GameTurnStatus.SUBMITTED,
                imageKey: 'a.jpg',
                submittedAt: new Date(),
                aiScore: null,
                aiFeedback: null,
                aiEvaluationStatus: GameTurnEvaluationStatus.PENDING,
              },
            ]),
          };
        }
        throw new Error('unexpected');
      });

      const result = await service.getResult(5, 1);

      expect(result.evaluationComplete).toBe(false);
      expect(result.turns[0].score).toBeNull();
      // 아직 채점 전이므로 총점에도 반영되지 않는다 (임의 점수 생성 금지).
      expect(result.ranking).toEqual([
        { userId: 10, nickname: '수연', totalScore: 0, rank: 1 },
      ]);
    });
  });
});
