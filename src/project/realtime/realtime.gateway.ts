import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Namespace } from 'socket.io';
import { LobbyRealtimeHandler } from './handlers/lobby-realtime.handler';
import { GameRealtimeHandler } from './handlers/game-realtime.handler';
import { RealtimeAuthService } from './security/realtime-auth.service';
import type { RealtimeSocket } from './types/realtime-socket.type';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { UpdateLobbyRoomDto } from './dto/update-lobby-room.dto';
import { ChangeLobbyHostDto } from './dto/change-lobby-host.dto';
import { LeaveLobbyDto } from './dto/leave-lobby.dto';
import { StartGameDto } from './dto/start-game.dto';
import { SubscribeGameDto } from './dto/subscribe-game.dto';
import { SubmitGameTurnDto } from './dto/submit-game-turn.dto';

@WebSocketGateway({
  namespace: '/realtime',
  transports: ['websocket'],
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
  },
})
export class RealtimeGateway {
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(RealtimeGateway.name);

  // gameId 별 "다음 턴 만료" 타이머. 인메모리이므로 서버가 재시작되면 유실된다.
  private readonly turnTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly lobbyHandler: LobbyRealtimeHandler,
    private readonly gameHandler: GameRealtimeHandler,
    private readonly realtimeAuthService: RealtimeAuthService,
  ) {}

  afterInit(server: Namespace): void {
    server.use((rawClient, next): void => {
      const client = rawClient as RealtimeSocket;

      void this.realtimeAuthService
        .authenticate(client)
        .then((userId) => {
          client.data.userId = userId;
          next();
        })
        .catch(() => {
          next(new Error('UNAUTHORIZED'));
        });
    });
  }

  // 대기실 구독
  @SubscribeMessage('lobby:subscribe')
  async subscribeLobby(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: { roomId: number },
  ) {
    const userId = this.getUserId(client);

    const state = await this.lobbyHandler.subscribe(body.roomId, userId);

    await this.moveChannel(client, `lobby:${body.roomId}`);

    client.emit('lobby:state', state);

    return {
      success: true,
      roomId: body.roomId,
    };
  }

  // 준비 상태 변경
  @SubscribeMessage('lobby:ready:set')
  async changeReady(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody()
    body: {
      roomId: number;
      isReady: boolean;
    },
  ) {
    const userId = this.getUserId(client);
    const channel = `lobby:${body.roomId}`;

    this.validateChannel(client, channel);

    const changedMember = await this.lobbyHandler.changeReady(
      body.roomId,
      userId,
      body.isReady,
    );

    this.server.to(channel).emit('lobby:ready-changed', changedMember);

    return {
      success: true,
    };
  }

  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('lobby:room:update')
  async updateRoom(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: UpdateLobbyRoomDto,
  ) {
    const userId = this.getUserId(client);
    const channel = `lobby:${body.roomId}`;

    // 현재 이 대기실을 구독하는지도 확인
    this.validateChannel(client, channel);

    const { roomId, ...updateRoomDto } = body;

    // DB 변경 및 방장·상태 검증
    const room = await this.lobbyHandler.updateRoom(
      roomId,
      userId,
      updateRoomDto,
    );

    const changedRoom = {
      id: room.id,
      title: room.title,
      status: room.status,
      hostId: room.hostId,
      minParticipants: room.minParticipants,
      maxParticipants: room.maxParticipants,
      isPublic: room.isPublic,
      relayCount: room.relayCount,
      timeLimitSeconds: room.timeLimitSeconds,
      updatedAt: room.updatedAt,
    };

    // 방장 포함 대기실 전원에게 전송
    this.server.to(channel).emit('lobby:room-updated', changedRoom);

    return {
      success: true,
      room: changedRoom,
    };
  }

  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('lobby:host:change')
  async changeHost(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: ChangeLobbyHostDto,
  ) {
    // 현재 방장은 JWT로 확인
    const currentUserId = this.getUserId(client);

    const channel = `lobby:${body.roomId}`;

    this.validateChannel(client, channel);

    const result = await this.lobbyHandler.changeHost(
      body.roomId,
      currentUserId,
      body.newHostUserId,
    );

    // 기존 방장과 새로운 방장을 포함한 방 전체에 전달
    this.server.to(channel).emit('lobby:host-changed', result);

    return {
      success: true,
      ...result,
    };
  }

  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('lobby:leave')
  async leaveLobby(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: LeaveLobbyDto,
  ) {
    const userId = this.getUserId(client);
    const channel = `lobby:${body.roomId}`;

    this.validateChannel(client, channel);

    const result = await this.lobbyHandler.leaveRoom(body.roomId, userId);

    if (result.roomDeleted) {
      this.server.to(channel).emit('lobby:room-closed', {
        roomId: result.roomId,
      });
    } else {
      this.server.to(channel).emit('lobby:member-left', {
        roomId: result.roomId,
        userId: result.leftUserId,
        currentParticipants: result.currentParticipants,
      });

      if (
        result.hostChanged &&
        result.previousHostId !== null &&
        result.newHostId !== null
      ) {
        this.server.to(channel).emit('lobby:host-changed', {
          roomId: result.roomId,
          previousHostId: result.previousHostId,
          newHostId: result.newHostId,
        });
      }
    }

    // Socket.IO 대기실 채널 구독 해제
    await client.leave(channel);

    if (client.data.activeSessionChannel === channel) {
      delete client.data.activeSessionChannel;
    }

    return {
      success: true,
      ...result,
    };
  }

  // 게임 시작 (방장 전용) - 대기실 구독자 전원에게 게임 시작을 알린다.
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('game:start')
  async startGame(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: StartGameDto,
  ) {
    const userId = this.getUserId(client);
    const channel = `lobby:${body.roomId}`;

    this.validateChannel(client, channel);

    const game = await this.gameHandler.startGame(body.roomId, userId);

    this.server.to(channel).emit('lobby:game-started', {
      roomId: game.roomId,
      gameId: game.gameId,
      status: game.status,
      countdownEndsAt: game.countdownEndsAt,
      totalTurns: game.totalTurns,
      timeLimitSeconds: game.timeLimitSeconds,
      turns: game.turns,
    });

    this.scheduleFirstTurn(game.gameId, game.countdownEndsAt);

    return {
      success: true,
      ...game,
    };
  }

  // 게임 진행 화면 구독 - 현재 세션/턴 상태를 전달한다.
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('game:subscribe')
  async subscribeGame(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: SubscribeGameDto,
  ) {
    const userId = this.getUserId(client);

    const state = await this.gameHandler.getSessionState(body.gameId, userId);

    await this.moveChannel(client, this.gameChannel(body.gameId));

    client.emit('game:state', state);

    return {
      success: true,
      gameId: body.gameId,
    };
  }

  // 사진 제출 및 턴 진행
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('game:turn:submit')
  async submitTurn(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: SubmitGameTurnDto,
  ) {
    const userId = this.getUserId(client);
    const channel = this.gameChannel(body.gameId);

    this.validateChannel(client, channel);

    const result = await this.gameHandler.submitTurn(
      body.gameId,
      userId,
      body.imageKey,
    );

    this.clearTurnTimer(body.gameId);

    this.server.to(channel).emit('game:turn-submitted', {
      gameId: result.gameId,
      roomId: result.roomId,
      submittedTurn: result.submittedTurn,
    });

    this.handleTurnAdvance(channel, result);

    return {
      success: true,
      ...result,
    };
  }

  // 카운트다운 종료 후 첫 턴을 시작한다.
  private scheduleFirstTurn(gameId: number, countdownEndsAt: Date): void {
    const delay = Math.max(0, countdownEndsAt.getTime() - Date.now());

    setTimeout(() => {
      void this.beginFirstTurn(gameId);
    }, delay);
  }

  private async beginFirstTurn(gameId: number): Promise<void> {
    try {
      const result = await this.gameHandler.beginFirstTurn(gameId);

      // 이미 시작되었거나(경합) 게임을 찾을 수 없는 경우
      if (!result) {
        return;
      }

      const channel = this.gameChannel(gameId);

      this.server.to(channel).emit('game:turn-started', {
        gameId: result.gameId,
        roomId: result.roomId,
        turnNumber: result.turnNumber,
        userId: result.userId,
        startedAt: result.startedAt,
        expiresAt: result.expiresAt,
      });

      this.scheduleTurnExpiry(gameId, result.expiresAt);
    } catch (error) {
      this.logger.error(
        `게임(${gameId}) 첫 턴 시작 처리 실패`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // 제한 시간이 지나도록 제출하지 않으면 자동으로 턴을 만료시키고 다음 턴으로 진행한다.
  private scheduleTurnExpiry(gameId: number, expiresAt: Date): void {
    this.clearTurnTimer(gameId);

    const delay = Math.max(0, expiresAt.getTime() - Date.now());

    const timer = setTimeout(() => {
      void this.expireCurrentTurn(gameId);
    }, delay);

    this.turnTimers.set(gameId, timer);
  }

  private async expireCurrentTurn(gameId: number): Promise<void> {
    try {
      const result = await this.gameHandler.expireCurrentTurn(gameId);

      // 이미 제출되었거나(경합) 진행 중인 게임이 아닌 경우
      if (!result) {
        this.turnTimers.delete(gameId);
        return;
      }

      const channel = this.gameChannel(gameId);

      this.server.to(channel).emit('game:turn-expired', {
        gameId: result.gameId,
        roomId: result.roomId,
        expiredTurn: result.expiredTurn,
      });

      this.handleTurnAdvance(channel, result);
    } catch (error) {
      this.turnTimers.delete(gameId);

      this.logger.error(
        `게임(${gameId}) 턴 만료 처리 실패`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // 제출/만료 이후 다음 턴 시작 또는 게임 종료를 방송한다.
  private handleTurnAdvance(
    channel: string,
    result: {
      finished: boolean;
      gameId: number;
      roomId: number;
      nextTurn: {
        turnNumber: number;
        userId: number;
        startedAt: Date;
        expiresAt: Date;
      } | null;
    },
  ): void {
    if (result.finished) {
      this.clearTurnTimer(result.gameId);

      this.server.to(channel).emit('game:finished', {
        gameId: result.gameId,
        roomId: result.roomId,
      });

      return;
    }

    if (result.nextTurn) {
      this.server.to(channel).emit('game:turn-started', {
        gameId: result.gameId,
        roomId: result.roomId,
        turnNumber: result.nextTurn.turnNumber,
        userId: result.nextTurn.userId,
        startedAt: result.nextTurn.startedAt,
        expiresAt: result.nextTurn.expiresAt,
      });

      this.scheduleTurnExpiry(result.gameId, result.nextTurn.expiresAt);
    }
  }

  private clearTurnTimer(gameId: number): void {
    const timer = this.turnTimers.get(gameId);

    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(gameId);
    }
  }

  private gameChannel(gameId: number): string {
    return `game:${gameId}`;
  }

  private async moveChannel(
    client: RealtimeSocket,
    nextChannel: string,
  ): Promise<void> {
    const previousChannel = client.data.activeSessionChannel;

    if (previousChannel && previousChannel !== nextChannel) {
      await client.leave(previousChannel);
    }

    await client.join(nextChannel);

    client.data.activeSessionChannel = nextChannel;
  }

  private validateChannel(client: RealtimeSocket, channel: string): void {
    if (!client.rooms.has(channel)) {
      throw new WsException('해당 실시간 채널에 참여하고 있지 않습니다.');
    }
  }

  private getUserId(client: RealtimeSocket): number {
    const userId = client.data.userId;

    if (!userId) {
      throw new WsException('인증이 필요합니다.');
    }

    return userId;
  }
}
