import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
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
import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { UpdateLobbyRoomDto } from './dto/update-lobby-room.dto';
import { ChangeLobbyHostDto } from './dto/change-lobby-host.dto';
import { LeaveLobbyDto } from './dto/leave-lobby.dto';
import { StartGameDto } from './dto/start-game.dto';
import { SubscribeGameDto } from './dto/subscribe-game.dto';
import { SubmitGameTurnDto } from './dto/submit-game-turn.dto';
import { LeaveGameDto } from './dto/leave-game.dto';
import { WsHttpExceptionFilter } from './filters/ws-http-exception.filter';

@WebSocketGateway({
  namespace: '/realtime',
  transports: ['websocket'],
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
  },
})
@UseFilters(WsHttpExceptionFilter)
export class RealtimeGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(RealtimeGateway.name);

  // gameId 별 "다음 턴 만료"(또는 카운트다운 종료) 타이머. 인메모리이므로
  // 서버가 재시작되면 유실된다 — afterInit()에서 진행 중인 게임의 타이머를 복구한다.
  private readonly turnTimers = new Map<number, NodeJS.Timeout>();

  // 게임 화면 소켓이 끊겼을 때(새로고침/일시적 네트워크 끊김 등) 곧바로 이탈 처리하지 않고
  // 재연결 유예 시간을 둔다. "${gameId}:${userId}" 키로 관리하며, 유예 시간 내에
  // game:subscribe로 같은 게임에 재구독하면 취소된다. 타이머 자체는 인메모리이므로
  // turnTimers와 마찬가지로 서버 재시작 시 유실될 수 있다.
  private readonly disconnectGraceTimers = new Map<string, NodeJS.Timeout>();

  private static readonly DISCONNECT_GRACE_MS = 15_000;

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

    void this.resumeInFlightGameTimers();
  }

  // 서버 (재)시작 시(개발 서버 hot-reload 포함) 인메모리 타이머가 유실된
  // 진행 중인 게임을 찾아 타이머를 다시 등록한다. 이미 만료 시각이 지났다면
  // scheduleTurnExpiry/scheduleFirstTurn이 즉시(0ms) 실행해 정상적으로 이어서 진행된다.
  private async resumeInFlightGameTimers(): Promise<void> {
    try {
      const sessions = await this.gameHandler.findResumableSessions();

      for (const session of sessions) {
        if (session.phase === 'countdown') {
          this.scheduleFirstTurn(session.gameId, session.countdownEndsAt);
        } else {
          this.scheduleTurnExpiry(session.gameId, session.expiresAt);
        }
      }

      if (sessions.length > 0) {
        this.logger.log(
          `서버 시작 시 진행 중이던 게임 ${sessions.length}건의 타이머를 복구했습니다.`,
        );
      }
    } catch (error) {
      this.logger.error(
        '게임 타이머 복구 중 오류가 발생했습니다.',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // 대기실 구독
  @SubscribeMessage('lobby:subscribe')
  async subscribeLobby(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: { roomId: number },
  ) {
    const userId = this.getUserId(client);
    const channel = `lobby:${body.roomId}`;

    // 구독 사용자 한 명의 정보 조회
    const joinedMember = await this.lobbyHandler.subscribe(body.roomId, userId);

    // Socket.IO 채널 참여
    await this.moveChannel(client, channel);

    // 새 사용자 본인을 제외한 기존 사용자에게 전송
    client.to(channel).emit('lobby:member-joined', joinedMember);

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
      topic: game.topic,
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

    // 유예 시간 내 재구독이므로 예정된 연결-종료 기반 이탈 처리를 취소한다.
    this.cancelDisconnectGrace(body.gameId, userId);

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

  // 게임 진행 중(COUNTDOWN/IN_PROGRESS) 이탈. WAITING 상태의 lobby:leave와는
  // 별개의 흐름이다 — 게임 전체를 취소하지 않고, 남은 활성 참여자끼리 계속 진행한다.
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('game:leave')
  async leaveGame(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() body: LeaveGameDto,
  ) {
    const userId = this.getUserId(client);
    const channel = this.gameChannel(body.gameId);

    this.validateChannel(client, channel);

    const result = await this.processGameLeave(body.gameId, userId);

    await client.leave(channel);

    if (client.data.activeSessionChannel === channel) {
      delete client.data.activeSessionChannel;
    }

    return {
      success: true,
      ...result,
    };
  }

  // 소켓 연결이 끊기면(새로고침/탭·브라우저 종료 등) 곧바로 이탈 처리하지 않고
  // 재연결 유예 시간을 둔 뒤 명시적 game:leave와 동일한 로직으로 처리한다.
  // WAITING(로비) 단계의 연결 끊김은 별도로 다루지 않는다 — 게임 화면(game:*) 구독
  // 중이었을 때만 대상이 된다.
  async handleDisconnect(client: RealtimeSocket): Promise<void> {
    const userId = client.data.userId;
    const channel = client.data.activeSessionChannel;

    if (!userId || !channel || !channel.startsWith('game:')) {
      return;
    }

    const gameId = Number(channel.slice('game:'.length));

    if (!Number.isInteger(gameId)) {
      return;
    }

    // 같은 유저의 다른 소켓(다중 탭 등)이 이 게임 채널에 여전히 남아있다면
    // 순간적인 연결 끊김으로 보고 이탈 처리 대상에서 제외한다.
    const remainingSockets = await this.server.in(channel).fetchSockets();

    const stillConnected = remainingSockets.some(
      (socket) => (socket.data as RealtimeSocket['data']).userId === userId,
    );

    if (stillConnected) {
      return;
    }

    this.scheduleDisconnectGrace(gameId, userId);
  }

  private scheduleDisconnectGrace(gameId: number, userId: number): void {
    const key = this.disconnectGraceKey(gameId, userId);

    if (this.disconnectGraceTimers.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.disconnectGraceTimers.delete(key);
      void this.handleDisconnectGraceExpired(gameId, userId);
    }, RealtimeGateway.DISCONNECT_GRACE_MS);

    this.disconnectGraceTimers.set(key, timer);
  }

  private cancelDisconnectGrace(gameId: number, userId: number): void {
    const key = this.disconnectGraceKey(gameId, userId);
    const timer = this.disconnectGraceTimers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.disconnectGraceTimers.delete(key);
    }
  }

  private disconnectGraceKey(gameId: number, userId: number): string {
    return `${gameId}:${userId}`;
  }

  private async handleDisconnectGraceExpired(
    gameId: number,
    userId: number,
  ): Promise<void> {
    try {
      await this.processGameLeave(gameId, userId);

      // 연결 종료 유예 만료로 실제 이탈 처리된 경우를 명시적 game:leave와 구분해
      // 추적할 수 있도록 남긴다 (원인 파악용).
      this.logger.log(
        `게임(${gameId}) 유저(${userId}) 연결 종료 유예 시간(${RealtimeGateway.DISCONNECT_GRACE_MS}ms) 만료로 이탈 처리됨.`,
      );
    } catch (error) {
      // 유예 시간 사이 게임이 이미 다른 방식으로 종료되었거나, 이미 이탈 처리된 경우 등은
      // 정상적인 경쟁 상황이므로 에러를 밖으로 던지지 않고 로그만 남긴다.
      this.logger.warn(
        `게임(${gameId}) 유저(${userId}) 연결 종료 유예 처리 중: ${
          error instanceof Error ? error.message : '알 수 없는 오류'
        }`,
      );
    }
  }

  // 이탈 처리 + 브로드캐스트. 명시적 game:leave와 연결 종료 유예 만료 양쪽에서 재사용한다.
  private async processGameLeave(gameId: number, userId: number) {
    const channel = this.gameChannel(gameId);

    const result = await this.gameHandler.leaveActiveGame(gameId, userId);

    // 게임이 계속되든 종료되든, 이탈 사실 자체는 항상 알린다.
    this.server.to(channel).emit('game:player-left', {
      gameId: result.gameId,
      roomId: result.roomId,
      leftUserId: result.leftUserId,
      remainingParticipants: result.remainingParticipants,
    });

    if (result.finished) {
      this.clearTurnTimer(result.gameId);

      // 정상 종료와 동일한 이벤트를 재사용해, 남은 참여자가 기존 종료 흐름 그대로
      // 결과 화면으로 이동할 수 있도록 한다.
      this.server.to(channel).emit('game:finished', {
        gameId: result.gameId,
        roomId: result.roomId,
      });
    } else if (result.turnAdvance) {
      // 이탈한 사용자가 현재 턴 당사자였던 경우 - 다음 턴 시작/게임 종료를 기존 로직으로 방송한다.
      this.handleTurnAdvance(channel, result.turnAdvance);
    }

    return result;
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
