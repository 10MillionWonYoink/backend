import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { Room, RoomStatus } from '../rooms/entities/room.entity';
import { RoomMember } from '../rooms/entities/room-member.entity';
import { GameSession, GameStatus } from './entities/game-session.entity';
import {
  GameTurn,
  GameTurnEvaluationStatus,
  GameTurnStatus,
} from './entities/game-turn.entity';
import { GeminiService } from '../ai/gemini.service';
import { ImageUrlResolver } from './image-url.resolver';
import { UploadsService } from '../uploads/uploads.service';

export interface TurnAdvanceResult {
  finished: boolean;
  gameId: number;
  roomId: number;
  nextTurn: {
    turnNumber: number;
    userId: number;
    startedAt: Date;
    expiresAt: Date;
  } | null;
}

// 서버(재)시작 시 인메모리 턴 타이머를 복구하기 위해 필요한 최소 정보.
export type ResumableSession =
  | { gameId: number; phase: 'countdown'; countdownEndsAt: Date }
  | { gameId: number; phase: 'turn'; turnNumber: number; expiresAt: Date };

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly geminiService: GeminiService,
    private readonly uploadsService: UploadsService,
    private readonly imageUrlResolver: ImageUrlResolver,
  ) {}

  async startGame(roomId: number, userId: number) {
    // 방 잠금(트랜잭션) 전에 미리 생성한다: AI 호출 동안 방/멤버 행을 잠그지 않기 위함.
    // 실패해도 게임 시작 자체는 막지 않는다 (topic은 null로 저장됨).
    const topic = await this.generateTopicSafely();

    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const memberRepository = manager.getRepository(RoomMember);

      const gameRepository = manager.getRepository(GameSession);

      const turnRepository = manager.getRepository(GameTurn);

      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.hostId !== userId) {
        throw new ForbiddenException('방장만 게임을 시작할 수 있습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        throw new ConflictException('대기 중인 방만 시작할 수 있습니다.');
      }

      const members = await memberRepository.find({
        where: {
          roomId,
          leftAt: IsNull(),
        },
        order: {
          joinedAt: 'ASC',
        },
      });

      if (members.length < room.minParticipants) {
        throw new ConflictException(
          `최소 ${room.minParticipants}명이 필요합니다.`,
        );
      }

      // 방장을 제외한 참여자는 준비가 필요하다는 규칙
      const everyoneReady = members
        .filter((member) => member.userId !== room.hostId)
        .every((member) => member.isReady);

      if (!everyoneReady) {
        throw new ConflictException('아직 준비하지 않은 참여자가 있습니다.');
      }

      // turnOrder가 있으면 우선 사용하고,
      // 없으면 입장 순서 사용
      members.sort((a, b) => {
        const aOrder = a.turnOrder ?? Number.MAX_SAFE_INTEGER;

        const bOrder = b.turnOrder ?? Number.MAX_SAFE_INTEGER;

        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }

        return a.joinedAt.getTime() - b.joinedAt.getTime();
      });

      const countdownEndsAt = new Date(Date.now() + 3_000);
      const totalTurns = members.length * room.relayCount;

      const game = gameRepository.create({
        roomId: room.id,
        status: GameStatus.COUNTDOWN,
        currentTurnNumber: 0,
        totalTurns,
        timeLimitSeconds: room.timeLimitSeconds,
        initialImageKey: null,
        topic,
        countdownEndsAt,
        startedAt: null,
        finishedAt: null,
      });

      const savedGame = await gameRepository.save(game);

      /*
       * relayCount가 3이고 참여자가 3명이면:
       *
       * 전체 턴 = 3명 × 3회 = 9턴
       *
       * A → B → C
       * A → B → C
       * A → B → C
       */
      const turns = Array.from(
        {
          length: totalTurns,
        },
        (_, index) => {
          const member = members[index % members.length];

          return turnRepository.create({
            gameSessionId: savedGame.id,
            turnNumber: index + 1,
            userId: member.userId,
            status: GameTurnStatus.WAITING,
            imageKey: null,
            startedAt: null,
            expiresAt: null,
            submittedAt: null,
            topic: null,
          });
        },
      );

      await turnRepository.save(turns);

      room.status = RoomStatus.COUNTDOWN;

      await roomRepository.save(room);

      return {
        gameId: savedGame.id,
        roomId: room.id,
        status: savedGame.status,
        topic: savedGame.topic,
        countdownEndsAt,
        totalTurns,
        timeLimitSeconds: savedGame.timeLimitSeconds,
        turns: turns.map((turn) => ({
          turnNumber: turn.turnNumber,
          userId: turn.userId,
        })),
      };
    });
  }

  async beginFirstTurn(gameId: number) {
    const result = await this.dataSource.transaction(async (manager) => {
      const gameRepository = manager.getRepository(GameSession);

      const turnRepository = manager.getRepository(GameTurn);

      const roomRepository = manager.getRepository(Room);

      const game = await gameRepository.findOne({
        where: {
          id: gameId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!game) {
        throw new NotFoundException('게임을 찾을 수 없습니다.');
      }

      // 중복 실행 방지
      if (game.status !== GameStatus.COUNTDOWN) {
        return null;
      }

      // 카운트다운 중 일부 참여자가 이탈해 1번 턴이 스킵(EXPIRED)됐을 수 있으므로,
      // turnNumber 1이 아니라 "가장 이른 WAITING 턴"을 찾는다.
      const firstTurn = await turnRepository.findOne({
        where: {
          gameSessionId: game.id,
          status: GameTurnStatus.WAITING,
        },
        order: {
          turnNumber: 'ASC',
        },
      });

      if (!firstTurn) {
        throw new NotFoundException('첫 번째 턴을 찾을 수 없습니다.');
      }

      const startedAt = new Date();

      const expiresAt = new Date(
        startedAt.getTime() + game.timeLimitSeconds * 1_000,
      );

      game.status = GameStatus.IN_PROGRESS;
      game.currentTurnNumber = 1;
      game.startedAt = startedAt;

      firstTurn.status = GameTurnStatus.IN_PROGRESS;

      firstTurn.startedAt = startedAt;
      firstTurn.expiresAt = expiresAt;

      await gameRepository.save(game);
      await turnRepository.save(firstTurn);

      await roomRepository.update(game.roomId, {
        status: RoomStatus.IN_PROGRESS,
      });

      return {
        gameId: game.id,
        roomId: game.roomId,
        turnNumber: firstTurn.turnNumber,
        userId: firstTurn.userId,
        startedAt,
        expiresAt,
      };
    });

    // 턴 시작 트랜잭션 밖에서 개인 Topic을 생성한다 (AI 호출이 턴 시작/타이머를 지연시키지 않도록).
    if (result) {
      this.generateTurnTopicInBackground(gameId, result.turnNumber);
    }

    return result;
  }

  async submitTurn(gameId: number, userId: number, imageKey: string) {
    const uploadGame = await this.dataSource
      .getRepository(GameSession)
      .findOne({
        where: {
          id: gameId,
        },
        select: {
          id: true,
          roomId: true,
        },
      });

    if (!uploadGame) {
      throw new NotFoundException('게임을 찾을 수 없습니다.');
    }

    // S3에 파일이 실제로 존재하는지 확인
    await this.uploadsService.verifyUploadedImage({
      roomId: uploadGame.roomId,
      userId,
      objectKey: imageKey,
    });

    // DB 저장 전에 조회 URL 생성
    const imageUrl = await this.uploadsService.createImageReadUrl(imageKey);

    // 게임 상태 확인 및 DB 저장
    const transactionResult = await this.dataSource.transaction(
      async (manager) => {
        const gameRepository = manager.getRepository(GameSession);

        const turnRepository = manager.getRepository(GameTurn);

        const game = await gameRepository.findOne({
          where: {
            id: gameId,
          },
          lock: {
            mode: 'pessimistic_write',
          },
        });

        if (!game) {
          throw new NotFoundException('게임을 찾을 수 없습니다.');
        }

        if (game.status !== GameStatus.IN_PROGRESS) {
          throw new ConflictException('진행 중인 게임이 아닙니다.');
        }

        const currentTurn = await turnRepository.findOneBy({
          gameSessionId: game.id,
          turnNumber: game.currentTurnNumber,
        });

        if (!currentTurn) {
          throw new NotFoundException('현재 턴을 찾을 수 없습니다.');
        }

        if (currentTurn.userId !== userId) {
          throw new ForbiddenException(
            '현재 차례인 사용자만 제출할 수 있습니다.',
          );
        }

        const now = new Date();

        if (currentTurn.expiresAt && currentTurn.expiresAt < now) {
          throw new ConflictException('사진 제출 시간이 만료되었습니다.');
        }

        currentTurn.imageKey = imageKey;
        currentTurn.status = GameTurnStatus.SUBMITTED;
        currentTurn.submittedAt = now;

        await turnRepository.save(currentTurn);

        const advanceResult = await this.advanceTurn(manager, game, now);

        return {
          ...advanceResult,

          submittedTurn: {
            turnNumber: currentTurn.turnNumber,
            userId: currentTurn.userId,

            // nullable 프로퍼티 대신 확실한 string 변수 사용
            imageKey,
          },

          evaluation: {
            turnId: currentTurn.id,
            topic: currentTurn.topic,
          },
        };
      },
    );

    const { evaluation, ...result } = transactionResult;

    // AI 평가는 턴 제출 트랜잭션 밖에서 별도로 처리한다 (평가 실패/지연이
    // 턴 제출·게임 진행·타이머에 영향을 주지 않도록 하기 위함).
    this.evaluateTurnInBackground(
      evaluation.turnId,
      imageKey,
      evaluation.topic,
    );

    // 다음 턴이 시작됐다면(게임이 끝나지 않았다면) 그 턴의 개인 Topic도 생성한다.
    if (result.nextTurn) {
      this.generateTurnTopicInBackground(gameId, result.nextTurn.turnNumber);
    }

    // DB에는 imageKey, 클라이언트에는 imageUrl까지 반환
    return {
      ...result,
      submittedTurn: {
        ...result.submittedTurn,
        imageUrl,
      },
    };
  }

  // 제출된 사진을 AI로 채점한다. 실패해도 예외를 밖으로 던지지 않고
  // 턴의 평가 상태를 FAILED로 남기는 데 그친다 (게임 진행에는 영향 없음).
  private evaluateTurnInBackground(
    turnId: number,
    imageKey: string,
    topic: string | null,
  ): void {
    void this.runTurnEvaluation(turnId, imageKey, topic).catch((error) => {
      this.logger.warn(
        `턴(${turnId}) AI 평가 처리 중 예기치 못한 오류: ${
          error instanceof Error ? error.message : '알 수 없는 오류'
        }`,
      );
    });
  }

  private async runTurnEvaluation(
    turnId: number,
    imageKey: string,
    topic: string | null,
  ): Promise<void> {
    const turnRepository = this.dataSource.getRepository(GameTurn);

    if (!topic) {
      // Topic이 없으면 채점 기준이 없으므로 평가를 시도하지 않는다.
      await turnRepository.update(turnId, {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });

      return;
    }

    try {
      const imageUrl = await this.imageUrlResolver.resolve(imageKey);

      const { score, feedback } = await this.geminiService.evaluatePhoto({
        imageUrl,
        topic,
      });

      await turnRepository.update(turnId, {
        aiScore: score,
        aiFeedback: feedback,
        aiEvaluationStatus: GameTurnEvaluationStatus.COMPLETED,
        aiEvaluatedAt: new Date(),
      });
    } catch (error) {
      this.logger.warn(
        `턴(${turnId}) AI 평가 실패: ${
          error instanceof Error ? error.message : '알 수 없는 오류'
        }`,
      );

      await turnRepository.update(turnId, {
        aiEvaluationStatus: GameTurnEvaluationStatus.FAILED,
      });
    }
  }

  // 게임 시작 시 사용할 Topic을 생성한다. 실패해도 게임 시작을 막지 않고 null을 반환한다.
  private async generateTopicSafely(): Promise<string | null> {
    try {
      const { topic } = await this.geminiService.generateTopic();

      return topic;
    } catch (error) {
      this.logger.warn(
        `게임 Topic 생성 실패: ${
          error instanceof Error ? error.message : '알 수 없는 오류'
        }`,
      );

      return null;
    }
  }

  // 특정 턴의 개인 Topic을 생성해 GameTurn에 저장한다. 실패해도 예외를 밖으로
  // 던지지 않는다 (턴은 이미 시작됐으므로, Topic이 없어도 게임 진행에는 영향이 없다).
  private generateTurnTopicInBackground(
    gameId: number,
    turnNumber: number,
  ): void {
    void this.runTurnTopicGeneration(gameId, turnNumber).catch((error) => {
      this.logger.warn(
        `게임(${gameId}) 턴(${turnNumber}) Topic 생성 처리 중 예기치 못한 오류: ${
          error instanceof Error ? error.message : '알 수 없는 오류'
        }`,
      );
    });
  }

  private async runTurnTopicGeneration(
    gameId: number,
    turnNumber: number,
  ): Promise<void> {
    const topic = await this.generateTopicSafely();

    if (!topic) {
      // generateTopicSafely()가 이미 실패 사유를 로깅했다.
      // GameTurn.topic은 컬럼 기본값(null)으로 그대로 둔다.
      return;
    }

    const turnRepository = this.dataSource.getRepository(GameTurn);

    await turnRepository.update(
      { gameSessionId: gameId, turnNumber },
      { topic },
    );
  }

  // 시간 초과로 제출하지 못한 턴을 만료 처리하고 다음 턴으로 진행한다.
  async expireCurrentTurn(gameId: number) {
    const result = await this.dataSource.transaction(async (manager) => {
      const gameRepository = manager.getRepository(GameSession);

      const turnRepository = manager.getRepository(GameTurn);

      const game = await gameRepository.findOne({
        where: {
          id: gameId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!game) {
        throw new NotFoundException('게임을 찾을 수 없습니다.');
      }

      if (game.status !== GameStatus.IN_PROGRESS) {
        return null;
      }

      const currentTurn = await turnRepository.findOneBy({
        gameSessionId: game.id,
        turnNumber: game.currentTurnNumber,
      });

      if (!currentTurn || currentTurn.status !== GameTurnStatus.IN_PROGRESS) {
        // 이미 제출되었거나(경합 상태) 처리할 턴이 없음
        return null;
      }

      const now = new Date();

      if (currentTurn.expiresAt && currentTurn.expiresAt > now) {
        // 아직 만료되지 않음 (타이머 오차로 인한 조기 실행 방지)
        return null;
      }

      currentTurn.status = GameTurnStatus.EXPIRED;

      await turnRepository.save(currentTurn);

      const advanceResult = await this.advanceTurn(manager, game, now);

      return {
        ...advanceResult,
        expiredTurn: {
          turnNumber: currentTurn.turnNumber,
          userId: currentTurn.userId,
        },
      };
    });

    // 다음 턴이 시작됐다면(게임이 끝나지 않았다면) 그 턴의 개인 Topic을 생성한다.
    if (result?.nextTurn) {
      this.generateTurnTopicInBackground(gameId, result.nextTurn.turnNumber);
    }

    return result;
  }

  // 게임 진행 중(COUNTDOWN/IN_PROGRESS) 참여자가 이탈하는 상황을 처리한다.
  //
  // WAITING 상태의 일반적인 "방 나가기"(RoomsService.leaveRoom)와는 완전히 분리된 흐름이다:
  // - 방장 승계나 "마지막 인원이면 방 삭제" 같은 개념은 게임 도중에는 의미가 없다.
  // - GameSession.roomId는 onDelete: CASCADE이므로 방을 삭제하면 이미 쌓인 GameTurn(AI 평가·점수)이
  //   통째로 사라진다 — 그래서 방은 절대 삭제하지 않는다.
  //
  // 정책: 게임 전체를 취소하지 않고, 이탈한 참여자의 "아직 진행되지 않은" 턴만 EXPIRED로 건너뛴 뒤
  // 남은 활성 참여자끼리 기존 turnNumber/라운드 구조 그대로 계속 진행한다.
  // 남은 인원이 1명 이하가 되면 더 진행할 수 없으므로 즉시 종료(FINISHED)한다 — 이때도 정상 종료와
  // 동일한 상태를 재사용해, 남은 참여자가 결과 화면으로 정상 이동할 수 있게 한다.
  async leaveActiveGame(gameId: number, userId: number) {
    const result = await this.dataSource.transaction(async (manager) => {
      const gameRepository = manager.getRepository(GameSession);

      const roomRepository = manager.getRepository(Room);

      const memberRepository = manager.getRepository(RoomMember);

      const turnRepository = manager.getRepository(GameTurn);

      const game = await gameRepository.findOne({
        where: {
          id: gameId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!game) {
        throw new NotFoundException('게임을 찾을 수 없습니다.');
      }

      if (
        game.status !== GameStatus.COUNTDOWN &&
        game.status !== GameStatus.IN_PROGRESS
      ) {
        throw new ConflictException('이미 종료된 게임입니다.');
      }

      const room = await roomRepository.findOne({
        where: {
          id: game.roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      const leavingMember = await memberRepository.findOne({
        where: {
          roomId: game.roomId,
          userId,
          leftAt: IsNull(),
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!leavingMember) {
        throw new BadRequestException('현재 방에 참여 중인 사용자가 아닙니다.');
      }

      // RoomsService.leaveRoom()과 동일한 방식으로 실제 삭제 대신 퇴장 시각만 기록한다.
      leavingMember.leftAt = new Date();
      leavingMember.isReady = false;
      leavingMember.turnOrder = null;

      await memberRepository.save(leavingMember);

      const now = new Date();

      // 이탈한 참여자의 아직 시작되지 않은 턴은 건너뛴다. turnNumber/라운드 구조 자체는
      // 그대로 두고(재배치하지 않음) 해당 슬롯만 EXPIRED로 남긴다.
      await turnRepository.update(
        {
          gameSessionId: game.id,
          userId,
          status: GameTurnStatus.WAITING,
        },
        { status: GameTurnStatus.EXPIRED },
      );

      const remainingParticipants = await memberRepository.count({
        where: {
          roomId: game.roomId,
          leftAt: IsNull(),
        },
      });

      // 남은 인원이 1명 이하면 더 진행할 수 없다 — 즉시 종료.
      if (remainingParticipants <= 1) {
        if (game.status === GameStatus.IN_PROGRESS) {
          await turnRepository.update(
            {
              gameSessionId: game.id,
              turnNumber: game.currentTurnNumber,
              status: GameTurnStatus.IN_PROGRESS,
            },
            { status: GameTurnStatus.EXPIRED },
          );
        }

        await this.finishGame(manager, game, now);

        return {
          finished: true as const,
          gameId: game.id,
          roomId: game.roomId,
          leftUserId: userId,
          remainingParticipants,
          turnAdvance: null,
        };
      }

      // 이탈한 사용자가 현재 진행 중인 턴의 당사자였다면, 그 턴을 만료 처리하고
      // 남은 활성 참여자 기준으로 다음 턴을 진행한다 (COUNTDOWN 중 이탈이었다면 아직 시작된
      // 턴이 없으므로 여기서 할 일이 없다 — beginFirstTurn이 카운트다운 종료 시 자동으로
      // 첫 WAITING 턴을 찾아 시작한다).
      let turnAdvance: TurnAdvanceResult | null = null;

      if (game.status === GameStatus.IN_PROGRESS) {
        const currentTurn = await turnRepository.findOneBy({
          gameSessionId: game.id,
          turnNumber: game.currentTurnNumber,
        });

        if (
          currentTurn &&
          currentTurn.userId === userId &&
          currentTurn.status === GameTurnStatus.IN_PROGRESS
        ) {
          currentTurn.status = GameTurnStatus.EXPIRED;

          await turnRepository.save(currentTurn);

          turnAdvance = await this.advanceTurn(manager, game, now);
        }
      }

      return {
        finished: false as const,
        gameId: game.id,
        roomId: game.roomId,
        leftUserId: userId,
        remainingParticipants,
        turnAdvance,
      };
    });

    if (result.turnAdvance?.nextTurn) {
      this.generateTurnTopicInBackground(
        result.gameId,
        result.turnAdvance.nextTurn.turnNumber,
      );
    }

    return result;
  }

  // 게임을 종료 처리한다: 정상 완료든, 이탈로 인한 조기 종료든 동일하게 재사용된다.
  // 아직 시작되지 않은(WAITING) 턴이 남아있다면(이탈/조기 종료로 더는 진행되지 않으므로) 함께 정리한다.
  private async finishGame(
    manager: EntityManager,
    game: GameSession,
    now: Date,
  ): Promise<void> {
    const gameRepository = manager.getRepository(GameSession);

    const turnRepository = manager.getRepository(GameTurn);

    const roomRepository = manager.getRepository(Room);

    game.status = GameStatus.FINISHED;
    game.finishedAt = now;

    await gameRepository.save(game);

    await turnRepository.update(
      {
        gameSessionId: game.id,
        status: GameTurnStatus.WAITING,
      },
      { status: GameTurnStatus.EXPIRED },
    );

    await roomRepository.update(game.roomId, {
      status: RoomStatus.FINISHED,
    });
  }

  // 현재 턴 종료(제출/만료/이탈로 인한 스킵) 후 게임을 마치거나 다음 턴을 시작한다.
  // 이탈한 참여자의 턴은 leaveActiveGame에서 미리 EXPIRED 처리되므로, 여기서는
  // turnNumber 순으로 가장 가까운 WAITING 턴을 찾는 것만으로 자연스럽게 건너뛴다.
  private async advanceTurn(
    manager: EntityManager,
    game: GameSession,
    now: Date,
  ): Promise<TurnAdvanceResult> {
    const gameRepository = manager.getRepository(GameSession);

    const turnRepository = manager.getRepository(GameTurn);

    const nextTurn = await turnRepository.findOne({
      where: {
        gameSessionId: game.id,
        turnNumber: MoreThan(game.currentTurnNumber),
        status: GameTurnStatus.WAITING,
      },
      order: {
        turnNumber: 'ASC',
      },
    });

    // 남은 활성 참여자의 WAITING 턴이 더 없음 (모든 턴 완료, 또는 나머지가 전부 이탈로 스킵됨)
    if (!nextTurn) {
      await this.finishGame(manager, game, now);

      return {
        finished: true,
        gameId: game.id,
        roomId: game.roomId,
        nextTurn: null,
      };
    }

    const nextExpiresAt = new Date(
      now.getTime() + game.timeLimitSeconds * 1_000,
    );

    nextTurn.status = GameTurnStatus.IN_PROGRESS;

    nextTurn.startedAt = now;
    nextTurn.expiresAt = nextExpiresAt;

    game.currentTurnNumber = nextTurn.turnNumber;

    await turnRepository.save(nextTurn);
    await gameRepository.save(game);

    return {
      finished: false,
      gameId: game.id,
      roomId: game.roomId,
      nextTurn: {
        turnNumber: nextTurn.turnNumber,
        userId: nextTurn.userId,
        startedAt: nextTurn.startedAt,
        expiresAt: nextTurn.expiresAt,
      },
    };
  }

  // roomId 기준 가장 최근 게임(진행 중이거나 마지막으로 끝난 게임)을 조회한다.
  // 서버가 (재)시작될 때, 인메모리로만 관리되는 턴 타이머(RealtimeGateway.turnTimers)가
  // 유실된 진행 중인 게임을 찾아 복구할 수 있도록 최소 정보를 반환한다.
  // COUNTDOWN 상태면 첫 턴 시작 타이머를, IN_PROGRESS면 현재 턴의 만료 타이머를 복구해야 한다.
  async findResumableSessions(): Promise<ResumableSession[]> {
    const gameRepository = this.dataSource.getRepository(GameSession);

    const sessions = await gameRepository.find({
      where: [
        { status: GameStatus.COUNTDOWN },
        { status: GameStatus.IN_PROGRESS },
      ],
    });

    if (sessions.length === 0) {
      return [];
    }

    const turnRepository = this.dataSource.getRepository(GameTurn);

    const resumable: ResumableSession[] = [];

    for (const session of sessions) {
      if (session.status === GameStatus.COUNTDOWN) {
        if (session.countdownEndsAt) {
          resumable.push({
            gameId: session.id,
            phase: 'countdown',
            countdownEndsAt: session.countdownEndsAt,
          });
        }

        continue;
      }

      const currentTurn = await turnRepository.findOneBy({
        gameSessionId: session.id,
        turnNumber: session.currentTurnNumber,
      });

      if (
        currentTurn?.status === GameTurnStatus.IN_PROGRESS &&
        currentTurn.expiresAt
      ) {
        resumable.push({
          gameId: session.id,
          phase: 'turn',
          turnNumber: currentTurn.turnNumber,
          expiresAt: currentTurn.expiresAt,
        });
      }
    }

    return resumable;
  }

  async findLatestGameByRoom(roomId: number, userId: number) {
    await this.assertRoomMember(roomId, userId);

    const gameRepository = this.dataSource.getRepository(GameSession);

    const game = await gameRepository.findOne({
      where: {
        roomId,
      },
      order: {
        id: 'DESC',
      },
    });

    if (!game) {
      throw new NotFoundException('진행된 게임을 찾을 수 없습니다.');
    }

    return {
      gameId: game.id,
      roomId: game.roomId,
      status: game.status,
      countdownEndsAt: game.countdownEndsAt,
      currentTurnNumber: game.currentTurnNumber,
      totalTurns: game.totalTurns,
    };
  }

  // 진행 화면(재접속 포함)에 필요한 세션/턴 현황을 조회한다.
  async getSessionState(gameId: number, userId: number) {
    const game = await this.findGameOrThrow(gameId);

    await this.assertRoomMember(game.roomId, userId);

    const turnRepository = this.dataSource.getRepository(GameTurn);

    const turns = await turnRepository.find({
      where: {
        gameSessionId: game.id,
      },
      relations: {
        user: true,
      },
      order: {
        turnNumber: 'ASC',
      },
    });

    const currentTurn =
      turns.find((turn) => turn.turnNumber === game.currentTurnNumber) ?? null;

    return {
      gameId: game.id,
      roomId: game.roomId,
      status: game.status,
      topic: game.topic,
      countdownEndsAt: game.countdownEndsAt,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,
      currentTurnNumber: game.currentTurnNumber,
      totalTurns: game.totalTurns,
      timeLimitSeconds: game.timeLimitSeconds,
      currentTurn:
        currentTurn && currentTurn.status === GameTurnStatus.IN_PROGRESS
          ? {
              turnNumber: currentTurn.turnNumber,
              userId: currentTurn.userId,
              nickname: currentTurn.user.nickname,
              startedAt: currentTurn.startedAt,
              expiresAt: currentTurn.expiresAt,
              // 개인 미션이므로 현재 턴 당사자에게만 노출한다.
              topic: currentTurn.userId === userId ? currentTurn.topic : null,
            }
          : null,
      turns: turns.map((turn) => ({
        turnNumber: turn.turnNumber,
        userId: turn.userId,
        nickname: turn.user.nickname,
        status: turn.status,
        // 아직 제출되지 않은 턴의 이미지는 노출하지 않는다.
        imageKey:
          turn.status === GameTurnStatus.SUBMITTED ? turn.imageKey : null,
        submittedAt: turn.submittedAt,
      })),
    };
  }

  // 게임 결과 화면에서 사용하는 최종 릴레이 결과를 조회한다.
  async getResult(gameId: number, userId: number) {
    const game = await this.findGameOrThrow(gameId);

    await this.assertRoomMember(game.roomId, userId);

    if (
      game.status === GameStatus.COUNTDOWN ||
      game.status === GameStatus.IN_PROGRESS
    ) {
      throw new ConflictException('아직 종료되지 않은 게임입니다.');
    }

    const turnRepository = this.dataSource.getRepository(GameTurn);

    const roomRepository = this.dataSource.getRepository(Room);

    const [room, turns] = await Promise.all([
      roomRepository.findOneBy({
        id: game.roomId,
      }),

      turnRepository.find({
        where: {
          gameSessionId: game.id,
        },
        relations: {
          user: true,
        },
        order: {
          turnNumber: 'ASC',
        },
      }),
    ]);

    const resultTurns = await Promise.all(
      turns.map(async (turn) => {
        const imageUrl = turn.imageKey
          ? await this.uploadsService.createImageReadUrl(turn.imageKey)
          : null;

        return {
          turnNumber: turn.turnNumber,
          userId: turn.userId,
          nickname: turn.user.nickname,
          profileImageUrl: turn.user.profileImageUrl,
          status: turn.status,

          // DB에 저장된 S3 객체 경로
          imageKey: turn.imageKey,

          // 프론트에서 바로 보여줄 수 있는 URL
          imageUrl,

          submittedAt: turn.submittedAt,
          topic: turn.topic,

          score:
            turn.aiEvaluationStatus === GameTurnEvaluationStatus.COMPLETED
              ? turn.aiScore
              : null,

          feedback:
            turn.aiEvaluationStatus === GameTurnEvaluationStatus.COMPLETED
              ? turn.aiFeedback
              : null,
        };
      }),
    );

    return {
      gameId: game.id,
      roomId: game.roomId,
      roomTitle: room?.title ?? null,
      status: game.status,
      topic: game.topic,
      totalTurns: game.totalTurns,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,

      evaluationComplete: turns.every(
        (turn) =>
          turn.status !== GameTurnStatus.SUBMITTED ||
          turn.aiEvaluationStatus !== GameTurnEvaluationStatus.PENDING,
      ),

      ranking: this.buildRanking(turns),
      turns: resultTurns,
    };
  }

  // 참가자별 총점(AI 채점이 끝난 SUBMITTED 턴의 score 합)과 순위를 계산한다.
  // 동점은 표준 경쟁 순위(1224 방식)로 처리한다: 예) [100, 100, 80] -> [1, 1, 3]
  private buildRanking(
    turns: GameTurn[],
  ): { userId: number; nickname: string; totalScore: number; rank: number }[] {
    const totalsByUser = new Map<
      number,
      { nickname: string; totalScore: number }
    >();

    for (const turn of turns) {
      const nickname = turn.user.nickname ?? '익명';

      const entry = totalsByUser.get(turn.userId) ?? {
        nickname,
        totalScore: 0,
      };

      if (
        turn.aiEvaluationStatus === GameTurnEvaluationStatus.COMPLETED &&
        turn.aiScore !== null
      ) {
        entry.totalScore += turn.aiScore;
      }

      totalsByUser.set(turn.userId, entry);
    }

    const sorted = Array.from(totalsByUser.entries())
      .map(([userId, { nickname, totalScore }]) => ({
        userId,
        nickname,
        totalScore,
      }))
      .sort((a, b) => b.totalScore - a.totalScore);

    let previousScore: number | null = null;
    let previousRank = 0;

    return sorted.map((entry, index) => {
      const rank =
        previousScore === entry.totalScore ? previousRank : index + 1;

      previousScore = entry.totalScore;
      previousRank = rank;

      return { ...entry, rank };
    });
  }

  private async findGameOrThrow(gameId: number): Promise<GameSession> {
    const gameRepository = this.dataSource.getRepository(GameSession);

    const game = await gameRepository.findOneBy({ id: gameId });

    if (!game) {
      throw new NotFoundException('게임을 찾을 수 없습니다.');
    }

    return game;
  }

  private async assertRoomMember(
    roomId: number,
    userId: number,
  ): Promise<void> {
    const memberRepository = this.dataSource.getRepository(RoomMember);

    const member = await memberRepository.findOne({
      where: {
        roomId,
        userId,
      },
    });

    if (!member) {
      throw new ForbiddenException('해당 게임에 접근할 권한이 없습니다.');
    }
  }
}
