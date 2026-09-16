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
import { ImageUrlResolver } from './image-url.resolver';
import { UploadsService } from '../uploads/uploads.service';

// GamesService의 fire-and-forget AI 평가(runTurnEvaluation/evaluateTurnInBackground)는
// public API가 아니므로, 테스트에서만 타입 안전하게 접근하기 위한 헬퍼.
interface GamesServiceInternals {
  runTurnEvaluation: (
    turnId: number,
    imageKey: string,
    topic: string | null,
  ) => Promise<void>;
  evaluateTurnInBackground: (
    turnId: number,
    imageKey: string,
    topic: string | null,
  ) => void;
  runTurnTopicGeneration: (gameId: number, turnNumber: number) => Promise<void>;
  generateTurnTopicInBackground: (gameId: number, turnNumber: number) => void;
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
    generateTopic: jest.fn(),
    evaluatePhoto: jest.fn(),
  };
  const imageUrlResolver = {
    resolve: jest.fn(),
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

    // 기본값: AI가 설정되어 있지 않은 것처럼 실패시켜, 기존(비AI) 테스트들이
    // "AI 실패가 게임 진행에 영향을 주지 않는다"를 자연스럽게 함께 검증하게 한다.
    geminiService.generateTopic.mockRejectedValue(
      new GeminiApiError('GEMINI_API_KEY가 설정되지 않았습니다.'),
    );
    geminiService.evaluatePhoto.mockRejectedValue(
      new GeminiApiError('GEMINI_API_KEY가 설정되지 않았습니다.'),
    );
    imageUrlResolver.resolve.mockResolvedValue('https://example.com/photo.jpg');

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
        { provide: ImageUrlResolver, useValue: imageUrlResolver },
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

    it('Topic 생성이 성공하면 GameSession에 topic을 저장한다', async () => {
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
      geminiService.generateTopic.mockResolvedValue({
        topic: '오늘 가장 신나는 순간을 찍어보세요!',
      });

      const result = await service.startGame(1, 10);

      expect(result.topic).toBe('오늘 가장 신나는 순간을 찍어보세요!');
      expect(gameRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: '오늘 가장 신나는 순간을 찍어보세요!',
        }),
      );
    });

    it('Topic 생성 호출 자체가 실패해도 게임 시작에는 영향이 없다', async () => {
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
      geminiService.generateTopic.mockRejectedValue(new Error('network'));

      await expect(service.startGame(1, 10)).resolves.toEqual(
        expect.objectContaining({ status: GameStatus.COUNTDOWN, topic: null }),
      );
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
      turnRepository.findOneBy.mockResolvedValue({
        turnNumber: 1,
        userId: 10,
      });
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      const result = await service.beginFirstTurn(5);

      expect(result).toEqual(
        expect.objectContaining({
          gameId: 5,
          roomId: 1,
          turnNumber: 1,
          userId: 10,
        }),
      );
      expect(generateSpy).toHaveBeenCalledWith(5, 1);
    });

    it('중복 실행 방지로 null을 반환하면 Topic 생성을 트리거하지 않는다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        status: GameStatus.IN_PROGRESS,
      });
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      const result = await service.beginFirstTurn(5);

      expect(result).toBeNull();
      expect(generateSpy).not.toHaveBeenCalled();
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
        imageUrl: 'https://example.com/signed-read-url',
      });
      expect(result.nextTurn?.turnNumber).toBe(2);
      expect(result.nextTurn?.userId).toBe(11);
      expect(roomRepository.update).not.toHaveBeenCalled();
      // 기존 응답 계약 유지: 내부적으로만 쓰이는 evaluation 필드가 새지 않아야 한다.
      expect(result).not.toHaveProperty('evaluation');
    });

    it('턴 제출은 AI 평가 완료를 기다리지 않고, "이 턴의" Topic으로 평가를 백그라운드에 위임한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        ...game,
        // 세션 전체 topic은 평가 기준으로 더 이상 쓰이지 않는다는 것을 명확히 하기 위해
        // 턴의 topic과 다른 값으로 설정한다.
        topic: '세션 topic(더 이상 평가에 쓰이지 않음)',
      });
      turnRepository.findOneBy
        .mockResolvedValueOnce({
          id: 101,
          gameSessionId: 5,
          turnNumber: 1,
          userId: 10,
          expiresAt: new Date(Date.now() + 60_000),
          topic: '파란색 물건 찾아 찍기',
        })
        .mockResolvedValueOnce({
          gameSessionId: 5,
          turnNumber: 2,
          userId: 11,
        });
      const evaluateSpy = jest
        .spyOn(internals(service), 'evaluateTurnInBackground')
        .mockImplementation(() => {});

      const result = await service.submitTurn(5, 10, 'key-1.jpg');

      expect(evaluateSpy).toHaveBeenCalledWith(
        101,
        'key-1.jpg',
        '파란색 물건 찾아 찍기',
      );
      // 평가 트리거는 결과가 반환되기 전에 이미 호출되어 있어야 한다 (제출을 막지 않음).
      expect(result.finished).toBe(false);
    });

    it('다음 턴이 시작되면 그 턴의 개인 Topic 생성을 백그라운드로 트리거한다', async () => {
      gameRepository.findOne.mockResolvedValue({ ...game });
      turnRepository.findOneBy
        .mockResolvedValueOnce({
          id: 101,
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
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      await service.submitTurn(5, 10, 'key-1.jpg');

      expect(generateSpy).toHaveBeenCalledWith(5, 2);
    });

    it('마지막 턴이면 게임과 방을 종료 상태로 만들고, 더 이상 Topic을 생성하지 않는다', async () => {
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
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      const result = await service.submitTurn(5, 11, 'key-2.jpg');

      expect(result.finished).toBe(true);
      expect(result.nextTurn).toBeNull();
      expect(roomRepository.update).toHaveBeenCalledWith(1, {
        status: RoomStatus.FINISHED,
      });
      expect(generateSpy).not.toHaveBeenCalled();
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

    it('제한 시간이 지난 턴을 만료시키고 다음 턴을 시작하며, 그 턴의 Topic 생성을 트리거한다', async () => {
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
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      const result = await service.expireCurrentTurn(5);

      expect(result?.expiredTurn).toEqual({ turnNumber: 1, userId: 10 });
      expect(result?.nextTurn?.turnNumber).toBe(2);
      expect(turnRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameTurnStatus.EXPIRED }),
      );
      expect(generateSpy).toHaveBeenCalledWith(5, 2);
    });

    it('만료로 게임이 종료되면 더 이상 Topic을 생성하지 않는다', async () => {
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
      const generateSpy = jest
        .spyOn(internals(service), 'generateTurnTopicInBackground')
        .mockImplementation(() => {});

      const result = await service.expireCurrentTurn(5);

      expect(result?.finished).toBe(true);
      expect(generateSpy).not.toHaveBeenCalled();
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

    it('IN_PROGRESS 게임에서 이탈하면 게임을 CANCELLED로, 방을 FINISHED로 바꾸고 현재 턴을 EXPIRED로 정리한다', async () => {
      gameRepository.findOne.mockResolvedValue({
        id: 5,
        roomId: 1,
        status: GameStatus.IN_PROGRESS,
        currentTurnNumber: 3,
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
      memberRepository.count.mockResolvedValue(1);

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
      expect(gameRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GameStatus.CANCELLED }),
      );
      expect(roomRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RoomStatus.FINISHED }),
      );
      expect(turnRepository.update).toHaveBeenCalledWith(
        { gameSessionId: 5, turnNumber: 3, status: GameTurnStatus.IN_PROGRESS },
        { status: GameTurnStatus.EXPIRED },
      );
      expect(result).toEqual({
        gameId: 5,
        roomId: 1,
        leftUserId: 10,
        cancelledTurnNumber: 3,
        remainingParticipants: 1,
      });
    });

    it('COUNTDOWN 단계(아직 턴이 시작되지 않음)에서 이탈하면 정리할 턴이 없다', async () => {
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
      memberRepository.count.mockResolvedValue(1);

      const result = await service.leaveActiveGame(6, 20);

      expect(turnRepository.update).not.toHaveBeenCalled();
      expect(result.cancelledTurnNumber).toBeNull();
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

  describe('runTurnEvaluation (AI 채점)', () => {
    it('평가에 성공하면 GameTurn에 score/feedback을 COMPLETED로 저장한다', async () => {
      imageUrlResolver.resolve.mockResolvedValue(
        'https://example.com/photo.jpg',
      );
      geminiService.evaluatePhoto.mockResolvedValue({
        score: 80,
        feedback: '주제와 잘 어울려요.',
      });

      await internals(service).runTurnEvaluation(101, 'key.jpg', '오늘의 하늘');

      expect(imageUrlResolver.resolve).toHaveBeenCalledWith('key.jpg');
      expect(geminiService.evaluatePhoto).toHaveBeenCalledWith({
        imageUrl: 'https://example.com/photo.jpg',
        topic: '오늘의 하늘',
      });
      expect(turnRepository.update).toHaveBeenCalledWith(
        101,
        expect.objectContaining({
          aiScore: 80,
          aiFeedback: '주제와 잘 어울려요.',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        }),
      );
    });

    it('AI 호출이 실패하면 예외를 던지지 않고 FAILED로 저장한다', async () => {
      imageUrlResolver.resolve.mockResolvedValue(
        'https://example.com/photo.jpg',
      );
      geminiService.evaluatePhoto.mockRejectedValue(
        new GeminiApiError('사진 평가 요청에 실패했습니다.'),
      );

      await expect(
        internals(service).runTurnEvaluation(101, 'key.jpg', '오늘의 하늘'),
      ).resolves.toBeUndefined();

      expect(turnRepository.update).toHaveBeenCalledWith(101, {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });

    it('이미지 URL 해석이 실패해도 예외를 던지지 않고 FAILED로 저장한다', async () => {
      imageUrlResolver.resolve.mockRejectedValue(
        new Error('S3 이미지 URL 변환이 아직 연동되지 않았습니다.'),
      );

      await expect(
        internals(service).runTurnEvaluation(101, 'key.jpg', '오늘의 하늘'),
      ).resolves.toBeUndefined();

      expect(geminiService.evaluatePhoto).not.toHaveBeenCalled();
      expect(turnRepository.update).toHaveBeenCalledWith(101, {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });

    it('Topic이 없으면 평가를 시도하지 않고 FAILED로 남긴다', async () => {
      await internals(service).runTurnEvaluation(101, 'key.jpg', null);

      expect(imageUrlResolver.resolve).not.toHaveBeenCalled();
      expect(geminiService.evaluatePhoto).not.toHaveBeenCalled();
      expect(turnRepository.update).toHaveBeenCalledWith(101, {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    });
  });

  describe('runTurnTopicGeneration (턴별 개인 Topic 생성)', () => {
    it('Topic 생성에 성공하면 해당 턴에 저장한다', async () => {
      geminiService.generateTopic.mockResolvedValue({
        topic: '파란색 물건 찾아 찍기',
      });

      await internals(service).runTurnTopicGeneration(5, 3);

      expect(turnRepository.update).toHaveBeenCalledWith(
        { gameSessionId: 5, turnNumber: 3 },
        { topic: '파란색 물건 찾아 찍기' },
      );
    });

    it('Topic 생성이 실패해도 예외를 던지지 않고, 저장도 시도하지 않는다', async () => {
      geminiService.generateTopic.mockRejectedValue(new Error('network'));

      await expect(
        internals(service).runTurnTopicGeneration(5, 3),
      ).resolves.toBeUndefined();

      expect(turnRepository.update).not.toHaveBeenCalled();
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

    it('참여자 이탈로 취소(CANCELLED)된 게임도 결과 조회는 허용한다 (남은 참여자가 진행 상황을 확인할 수 있도록)', async () => {
      dataSource.getRepository.mockImplementation((entity: unknown) => {
        if (entity === GameSession) {
          return {
            findOneBy: jest.fn().mockResolvedValue({
              id: 5,
              roomId: 1,
              status: GameStatus.CANCELLED,
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

      expect(result.status).toBe(GameStatus.CANCELLED);
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

    it('게임 결과에 topic, 턴별 score/feedback, 참가자별 총점·순위를 포함한다 (동점은 공동 순위)', async () => {
      const turns = [
        {
          turnNumber: 1,
          userId: 10,
          user: { nickname: '수연', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'a.jpg',
          submittedAt: new Date('2026-01-01T00:00:01Z'),
          topic: '주변에서 웃는 얼굴처럼 보이는 물건 찾아 찍기',
          aiScore: 80,
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
          aiScore: 20,
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
          aiScore: 20,
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
          aiScore: 80,
          aiFeedback: '멋져요',
          aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        },
        {
          turnNumber: 5,
          userId: 12,
          user: { nickname: '지훈', profileImageUrl: null },
          status: GameTurnStatus.SUBMITTED,
          imageKey: 'e.jpg',
          submittedAt: new Date('2026-01-01T00:00:05Z'),
          aiScore: 50,
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
          score: 80,
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

      // 수연(100) == 민준(100) > 지훈(50): 표준 경쟁 순위(1,1,3)
      expect(result.ranking).toEqual([
        { userId: 10, nickname: '수연', totalScore: 100, rank: 1 },
        { userId: 11, nickname: '민준', totalScore: 100, rank: 1 },
        { userId: 12, nickname: '지훈', totalScore: 50, rank: 3 },
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
