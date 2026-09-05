import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { Room, RoomStatus } from '../rooms/entities/room.entity';
import { RoomMember } from '../rooms/entities/room-member.entity';
import { GameSession, GameStatus } from './entities/game-session.entity';
import { GameTurn, GameTurnStatus } from './entities/game-turn.entity';

@Injectable()
export class GamesService {
  constructor(private readonly dataSource: DataSource) {}

  async startGame(roomId: number, userId: number) {
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

      const game = gameRepository.create({
        roomId: room.id,
        status: GameStatus.COUNTDOWN,
        currentTurnNumber: 0,
        totalTurns: room.relayCount,
        timeLimitSeconds: room.timeLimitSeconds,
        initialImageKey: null,
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
      const totalTurns = members.length * room.relayCount;

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
        countdownEndsAt,
        turns: turns.map((turn) => ({
          turnNumber: turn.turnNumber,
          userId: turn.userId,
        })),
      };
    });
  }

  async beginFirstTurn(gameId: number) {
    return this.dataSource.transaction(async (manager) => {
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

      const firstTurn = await turnRepository.findOneBy({
        gameSessionId: game.id,
        turnNumber: 1,
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
  }

  async submitTurn(gameId: number, userId: number, imageKey: string) {
    return this.dataSource.transaction(async (manager) => {
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
        throw new ConflictException('사진 제출 시간이 만료되었습니다졌습니다.');
      }

      currentTurn.imageKey = imageKey;
      currentTurn.status = GameTurnStatus.SUBMITTED;

      currentTurn.submittedAt = now;

      await turnRepository.save(currentTurn);

      // 마지막 턴
      if (game.currentTurnNumber >= game.totalTurns) {
        game.status = GameStatus.FINISHED;
        game.finishedAt = now;

        await gameRepository.save(game);

        await roomRepository.update(game.roomId, {
          status: RoomStatus.FINISHED,
        });

        return {
          finished: true,
          gameId: game.id,
          roomId: game.roomId,
          submittedTurn: {
            turnNumber: currentTurn.turnNumber,
            userId: currentTurn.userId,
            imageKey: currentTurn.imageKey,
          },
          nextTurn: null,
        };
      }

      const nextTurnNumber = game.currentTurnNumber + 1;

      const nextTurn = await turnRepository.findOneBy({
        gameSessionId: game.id,
        turnNumber: nextTurnNumber,
      });

      if (!nextTurn) {
        throw new NotFoundException('다음 턴을 찾을 수 없습니다.');
      }

      const nextExpiresAt = new Date(
        now.getTime() + game.timeLimitSeconds * 1_000,
      );

      nextTurn.status = GameTurnStatus.IN_PROGRESS;

      nextTurn.startedAt = now;
      nextTurn.expiresAt = nextExpiresAt;

      game.currentTurnNumber = nextTurnNumber;

      await turnRepository.save(nextTurn);
      await gameRepository.save(game);

      return {
        finished: false,
        gameId: game.id,
        roomId: game.roomId,
        submittedTurn: {
          turnNumber: currentTurn.turnNumber,
          userId: currentTurn.userId,
          imageKey: currentTurn.imageKey,
        },
        nextTurn: {
          turnNumber: nextTurn.turnNumber,
          userId: nextTurn.userId,
          startedAt: nextTurn.startedAt,
          expiresAt: nextTurn.expiresAt,
        },
      };
    });
  }
}
