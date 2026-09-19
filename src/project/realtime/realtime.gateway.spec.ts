import { Test, TestingModule } from '@nestjs/testing';
import { RealtimeGateway } from './realtime.gateway';
import { LobbyRealtimeHandler } from './handlers/lobby-realtime.handler';
import { GameRealtimeHandler } from './handlers/game-realtime.handler';
import { ChatRealtimeHandler } from './handlers/chat-realtime.handler';
import { RealtimeAuthService } from './security/realtime-auth.service';

interface RealtimeGatewayInternals {
  resumeInFlightGameTimers: () => Promise<void>;
}

function internals(gateway: RealtimeGateway): RealtimeGatewayInternals {
  return gateway as unknown as RealtimeGatewayInternals;
}

describe('RealtimeGateway - 서버 재시작 시 게임 타이머 복구', () => {
  let gateway: RealtimeGateway;

  const lobbyHandler = {};
  const chatHandler = {
    sendGlobalMessage: jest.fn(),
    sendRoomMessage: jest.fn(),
  };
  const gameHandler = {
    findResumableSessions: jest.fn(),
    beginFirstTurn: jest.fn(),
    expireCurrentTurn: jest.fn(),
  };
  const realtimeAuthService = { authenticate: jest.fn() };
  const emit = jest.fn();
  const server = { to: jest.fn(() => ({ emit })) };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    server.to.mockImplementation(() => ({ emit }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: LobbyRealtimeHandler, useValue: lobbyHandler },
        { provide: GameRealtimeHandler, useValue: gameHandler },
        { provide: ChatRealtimeHandler, useValue: chatHandler },
        { provide: RealtimeAuthService, useValue: realtimeAuthService },
      ],
    }).compile();

    gateway = module.get<RealtimeGateway>(RealtimeGateway);
    gateway.server = server as never;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('복구할 게임이 없으면 아무 타이머도 등록하지 않는다', async () => {
    gameHandler.findResumableSessions.mockResolvedValue([]);

    await internals(gateway).resumeInFlightGameTimers();
    await jest.advanceTimersByTimeAsync(100_000);

    expect(gameHandler.beginFirstTurn).not.toHaveBeenCalled();
    expect(gameHandler.expireCurrentTurn).not.toHaveBeenCalled();
  });

  it('COUNTDOWN 단계의 게임은 countdownEndsAt 시점에 beginFirstTurn을 호출한다', async () => {
    const countdownEndsAt = new Date(Date.now() + 1_000);
    gameHandler.findResumableSessions.mockResolvedValue([
      { gameId: 1, phase: 'countdown', countdownEndsAt },
    ]);
    gameHandler.beginFirstTurn.mockResolvedValue(null);

    await internals(gateway).resumeInFlightGameTimers();

    expect(gameHandler.beginFirstTurn).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);

    expect(gameHandler.beginFirstTurn).toHaveBeenCalledWith(1);
  });

  it('IN_PROGRESS 단계에서 이미 만료 시각이 지난 턴은 거의 즉시 expireCurrentTurn을 호출한다', async () => {
    const pastExpiresAt = new Date(Date.now() - 5_000);
    gameHandler.findResumableSessions.mockResolvedValue([
      { gameId: 2, phase: 'turn', turnNumber: 1, expiresAt: pastExpiresAt },
    ]);
    gameHandler.expireCurrentTurn.mockResolvedValue(null);

    await internals(gateway).resumeInFlightGameTimers();
    await jest.advanceTimersByTimeAsync(0);

    expect(gameHandler.expireCurrentTurn).toHaveBeenCalledWith(2);
  });

  it('복구된 턴 만료 타이머가 실제로 발화하면 game:turn-expired를 방송한다', async () => {
    const pastExpiresAt = new Date(Date.now() - 5_000);
    gameHandler.findResumableSessions.mockResolvedValue([
      { gameId: 3, phase: 'turn', turnNumber: 1, expiresAt: pastExpiresAt },
    ]);
    gameHandler.expireCurrentTurn.mockResolvedValue({
      finished: true,
      gameId: 3,
      roomId: 30,
      nextTurn: null,
      expiredTurn: { turnNumber: 1, userId: 9 },
    });

    await internals(gateway).resumeInFlightGameTimers();
    await jest.advanceTimersByTimeAsync(0);

    expect(server.to).toHaveBeenCalledWith('game:3');
    expect(emit).toHaveBeenCalledWith('game:turn-expired', {
      gameId: 3,
      roomId: 30,
      expiredTurn: { turnNumber: 1, userId: 9 },
    });
    expect(emit).toHaveBeenCalledWith('game:finished', {
      gameId: 3,
      roomId: 30,
    });
  });

  it('세션 조회 자체가 실패해도 예외를 밖으로 던지지 않는다', async () => {
    gameHandler.findResumableSessions.mockRejectedValue(new Error('DB down'));

    await expect(
      internals(gateway).resumeInFlightGameTimers(),
    ).resolves.toBeUndefined();
  });
});

interface FakeRealtimeSocket {
  data: { userId?: number; activeSessionChannel?: string };
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  to: jest.Mock;
}

function createFakeSocket(
  userId: number,
  activeSessionChannel?: string,
): FakeRealtimeSocket {
  return {
    data: { userId, activeSessionChannel },
    rooms: new Set(activeSessionChannel ? [activeSessionChannel] : []),
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  };
}

describe('RealtimeGateway - 게임 중 이탈 처리 (game:leave / disconnect)', () => {
  let gateway: RealtimeGateway;

  const lobbyHandler = {};
  const chatHandler = {
    sendGlobalMessage: jest.fn(),
    sendRoomMessage: jest.fn(),
  };
  const gameHandler = {
    findResumableSessions: jest.fn(),
    leaveActiveGame: jest.fn(),
    getSessionState: jest.fn(),
  };
  const realtimeAuthService = { authenticate: jest.fn() };
  const emit = jest.fn();
  const server = {
    to: jest.fn(() => ({ emit })),
    in: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    server.to.mockImplementation(() => ({ emit }));
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([]),
    }));
    gameHandler.findResumableSessions.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: LobbyRealtimeHandler, useValue: lobbyHandler },
        { provide: GameRealtimeHandler, useValue: gameHandler },
        { provide: ChatRealtimeHandler, useValue: chatHandler },
        { provide: RealtimeAuthService, useValue: realtimeAuthService },
      ],
    }).compile();

    gateway = module.get<RealtimeGateway>(RealtimeGateway);
    gateway.server = server as never;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('게임이 계속되는 경우(remainingParticipants >= 2) game:player-left만 방송하고 소켓은 채널을 나간다', async () => {
    gameHandler.leaveActiveGame.mockResolvedValue({
      finished: false,
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 2,
      turnAdvance: null,
    });
    const client = createFakeSocket(5, 'game:1');

    await gateway.leaveGame(client as never, { gameId: 1 });

    expect(server.to).toHaveBeenCalledWith('game:1');
    expect(emit).toHaveBeenCalledWith('game:player-left', {
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 2,
    });
    expect(emit).not.toHaveBeenCalledWith('game:finished', expect.anything());
    expect(emit).not.toHaveBeenCalledWith('game:cancelled', expect.anything());
    expect(client.leave).toHaveBeenCalledWith('game:1');
    expect(client.data.activeSessionChannel).toBeUndefined();
  });

  it('이탈자가 현재 턴 당사자였다면 game:player-left와 함께 다음 턴 시작도 방송한다', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    gameHandler.leaveActiveGame.mockResolvedValue({
      finished: false,
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 2,
      turnAdvance: {
        finished: false,
        gameId: 1,
        roomId: 2,
        nextTurn: {
          turnNumber: 4,
          userId: 11,
          startedAt: new Date(),
          expiresAt,
        },
      },
    });
    const client = createFakeSocket(5, 'game:1');

    await gateway.leaveGame(client as never, { gameId: 1 });

    expect(emit).toHaveBeenCalledWith(
      'game:player-left',
      expect.objectContaining({ leftUserId: 5 }),
    );
    expect(emit).toHaveBeenCalledWith(
      'game:turn-started',
      expect.objectContaining({ turnNumber: 4, userId: 11 }),
    );
  });

  it('남은 인원이 1명 이하가 되어 즉시 종료되면 game:player-left에 이어 game:finished를 방송한다 (game:cancelled는 사용하지 않는다)', async () => {
    gameHandler.leaveActiveGame.mockResolvedValue({
      finished: true,
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 1,
      turnAdvance: null,
    });
    const client = createFakeSocket(5, 'game:1');

    await gateway.leaveGame(client as never, { gameId: 1 });

    expect(emit).toHaveBeenCalledWith('game:player-left', {
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 1,
    });
    expect(emit).toHaveBeenCalledWith('game:finished', {
      gameId: 1,
      roomId: 2,
    });
    expect(emit).not.toHaveBeenCalledWith(
      'game:turn-started',
      expect.anything(),
    );
    expect(emit).not.toHaveBeenCalledWith('game:cancelled', expect.anything());
  });

  it('게임 화면 소켓 연결이 끊기면 15초 유예 후 game:leave와 동일하게 이탈 처리된다', async () => {
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([]),
    }));
    gameHandler.leaveActiveGame.mockResolvedValue({
      finished: false,
      gameId: 1,
      roomId: 2,
      leftUserId: 5,
      remainingParticipants: 2,
      turnAdvance: null,
    });
    const client = createFakeSocket(5, 'game:1');

    await gateway.handleDisconnect(client as never);

    expect(gameHandler.leaveActiveGame).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(15_000);

    expect(gameHandler.leaveActiveGame).toHaveBeenCalledWith(1, 5);
    expect(emit).toHaveBeenCalledWith(
      'game:player-left',
      expect.objectContaining({ leftUserId: 5 }),
    );
  });

  it('로비(lobby:*) 채널 구독 중 연결이 끊기면 아무 처리도 하지 않는다', async () => {
    const client = createFakeSocket(5, 'lobby:9');

    await gateway.handleDisconnect(client as never);
    await jest.advanceTimersByTimeAsync(20_000);

    expect(gameHandler.leaveActiveGame).not.toHaveBeenCalled();
  });

  it('같은 유저의 다른 소켓이 게임 채널에 남아있으면 유예 타이머를 등록하지 않는다', async () => {
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([{ data: { userId: 5 } }]),
    }));
    const client = createFakeSocket(5, 'game:1');

    await gateway.handleDisconnect(client as never);
    await jest.advanceTimersByTimeAsync(20_000);

    expect(gameHandler.leaveActiveGame).not.toHaveBeenCalled();
  });

  it('유예 시간 내에 같은 게임을 재구독하면 예정된 이탈 처리가 취소된다', async () => {
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([]),
    }));
    const disconnectedClient = createFakeSocket(5, 'game:1');

    await gateway.handleDisconnect(disconnectedClient as never);

    gameHandler.getSessionState.mockResolvedValue({ gameId: 1 });
    const reconnectedClient = createFakeSocket(5);

    await gateway.subscribeGame(reconnectedClient as never, { gameId: 1 });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(gameHandler.leaveActiveGame).not.toHaveBeenCalled();
  });

  it('유예 처리 중 오류(이미 종료된 게임 등)가 발생해도 예외를 밖으로 던지지 않는다', async () => {
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([]),
    }));
    gameHandler.leaveActiveGame.mockRejectedValue(new Error('이미 종료됨'));
    const client = createFakeSocket(5, 'game:1');

    await gateway.handleDisconnect(client as never);

    await expect(
      jest.advanceTimersByTimeAsync(15_000),
    ).resolves.toBeUndefined();
  });
});

describe('RealtimeGateway - 채팅 (chat:global / chat:room)', () => {
  let gateway: RealtimeGateway;

  const lobbyHandler = {
    subscribe: jest.fn(),
    leaveRoom: jest.fn(),
  };
  const gameHandler = {
    findResumableSessions: jest.fn(),
    getSessionState: jest.fn(),
    leaveActiveGame: jest.fn(),
  };
  const chatHandler = {
    sendGlobalMessage: jest.fn(),
    sendRoomMessage: jest.fn(),
  };
  const realtimeAuthService = { authenticate: jest.fn() };
  const emit = jest.fn();
  const server = {
    to: jest.fn(() => ({ emit })),
    in: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    server.to.mockImplementation(() => ({ emit }));
    server.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([]),
    }));
    gameHandler.findResumableSessions.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: LobbyRealtimeHandler, useValue: lobbyHandler },
        { provide: GameRealtimeHandler, useValue: gameHandler },
        { provide: ChatRealtimeHandler, useValue: chatHandler },
        { provide: RealtimeAuthService, useValue: realtimeAuthService },
      ],
    }).compile();

    gateway = module.get<RealtimeGateway>(RealtimeGateway);
    gateway.server = server as never;
  });

  it('chat:global:send는 chat:global 채널 전체에 방송한다', async () => {
    chatHandler.sendGlobalMessage.mockResolvedValue({
      id: 1,
      roomId: null,
      userId: 5,
      nickname: '수연',
      profileImageUrl: null,
      content: '안녕하세요',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const client = createFakeSocket(5);

    const result = await gateway.sendGlobalChatMessage(client as never, {
      content: '안녕하세요',
    });

    expect(chatHandler.sendGlobalMessage).toHaveBeenCalledWith(5, '안녕하세요');
    expect(server.to).toHaveBeenCalledWith('chat:global');
    expect(emit).toHaveBeenCalledWith(
      'chat:global:message',
      expect.objectContaining({ content: '안녕하세요' }),
    );
    expect(result.success).toBe(true);
  });

  it('chat:room:send는 방 채팅 채널(chat:room:{roomId})에 참여 중이어야 하며, 전체 채팅과 분리된 채널에 방송한다', async () => {
    chatHandler.sendRoomMessage.mockResolvedValue({
      id: 2,
      roomId: 7,
      userId: 5,
      nickname: '수연',
      profileImageUrl: null,
      content: '방 채팅',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const client = createFakeSocket(5, 'chat:room:7');

    const result = await gateway.sendRoomChatMessage(client as never, {
      roomId: 7,
      content: '방 채팅',
    });

    expect(chatHandler.sendRoomMessage).toHaveBeenCalledWith(7, 5, '방 채팅');
    expect(server.to).toHaveBeenCalledWith('chat:room:7');
    expect(emit).toHaveBeenCalledWith(
      'chat:room:message',
      expect.objectContaining({ roomId: 7, content: '방 채팅' }),
    );
    expect(result.success).toBe(true);
  });

  it('chat:room:send는 해당 방 채팅 채널에 참여하고 있지 않으면 거부한다 (전체 채팅과 대상이 섞이지 않음)', async () => {
    const client = createFakeSocket(5, 'chat:global');

    await expect(
      gateway.sendRoomChatMessage(client as never, {
        roomId: 7,
        content: '방 채팅',
      }),
    ).rejects.toThrow();
    expect(chatHandler.sendRoomMessage).not.toHaveBeenCalled();
  });

  it('lobby:subscribe 시 로비 채널과 별개로 방 채팅 채널(chat:room:{roomId})에도 자동 참여한다', async () => {
    lobbyHandler.subscribe.mockResolvedValue({ userId: 5, nickname: '수연' });
    const client = createFakeSocket(5);

    await gateway.subscribeLobby(client as never, { roomId: 7 });

    expect(client.join).toHaveBeenCalledWith('lobby:7');
    expect(client.join).toHaveBeenCalledWith('chat:room:7');
  });

  it('game:subscribe 시(재접속 포함) 게임 채널과 별개로 방 채팅 채널에도 참여한다', async () => {
    gameHandler.getSessionState.mockResolvedValue({ gameId: 1, roomId: 7 });
    const client = createFakeSocket(5);

    await gateway.subscribeGame(client as never, { gameId: 1 });

    expect(client.join).toHaveBeenCalledWith('game:1');
    expect(client.join).toHaveBeenCalledWith('chat:room:7');
  });

  it('lobby:leave 시 로비 채널과 함께 방 채팅 채널에서도 나간다', async () => {
    lobbyHandler.leaveRoom.mockResolvedValue({
      roomId: 7,
      leftUserId: 5,
      currentParticipants: 1,
      roomDeleted: false,
      hostChanged: false,
      previousHostId: null,
      newHostId: null,
    });
    const client = createFakeSocket(5, 'lobby:7');

    await gateway.leaveLobby(client as never, { roomId: 7 });

    expect(client.leave).toHaveBeenCalledWith('lobby:7');
    expect(client.leave).toHaveBeenCalledWith('chat:room:7');
  });

  it('game:leave 시 게임 채널과 함께 방 채팅 채널에서도 나간다 (방 참여 자체가 종료되므로)', async () => {
    gameHandler.leaveActiveGame.mockResolvedValue({
      finished: true,
      gameId: 1,
      roomId: 7,
      leftUserId: 5,
      remainingParticipants: 1,
      turnAdvance: null,
    });
    const client = createFakeSocket(5, 'game:1');

    await gateway.leaveGame(client as never, { gameId: 1 });

    expect(client.leave).toHaveBeenCalledWith('game:1');
    expect(client.leave).toHaveBeenCalledWith('chat:room:7');
  });
});
