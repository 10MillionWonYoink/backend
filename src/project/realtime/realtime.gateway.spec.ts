import { Test, TestingModule } from '@nestjs/testing';
import { RealtimeGateway } from './realtime.gateway';
import { LobbyRealtimeHandler } from './handlers/lobby-realtime.handler';
import { GameRealtimeHandler } from './handlers/game-realtime.handler';
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
