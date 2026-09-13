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
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { UpdateLobbyRoomDto } from './dto/update-lobby-room.dto';
import { ChangeLobbyHostDto } from './dto/change-lobby-host.dto';
import { LeaveLobbyDto } from './dto/leave-lobby.dto';

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
