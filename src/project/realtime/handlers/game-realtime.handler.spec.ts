import { Test, TestingModule } from '@nestjs/testing';
import { GameRealtimeHandler } from './game-realtime.handler';
import { GamesService } from '../../games/games.service';

describe('GameRealtimeHandler', () => {
  let handler: GameRealtimeHandler;
  const gamesService = {
    startGame: jest.fn(),
    beginFirstTurn: jest.fn(),
    submitTurn: jest.fn(),
    expireCurrentTurn: jest.fn(),
    getSessionState: jest.fn(),
    findResumableSessions: jest.fn(),
    leaveActiveGame: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameRealtimeHandler,
        { provide: GamesService, useValue: gamesService },
      ],
    }).compile();

    handler = module.get<GameRealtimeHandler>(GameRealtimeHandler);
  });

  it('startGame은 GamesService.startGame에 위임한다', async () => {
    gamesService.startGame.mockResolvedValue({ gameId: 1 });

    await expect(handler.startGame(1, 2)).resolves.toEqual({ gameId: 1 });
    expect(gamesService.startGame).toHaveBeenCalledWith(1, 2);
  });

  it('submitTurn은 GamesService.submitTurn에 위임한다', async () => {
    gamesService.submitTurn.mockResolvedValue({ finished: false });

    await expect(handler.submitTurn(1, 2, 'key.jpg')).resolves.toEqual({
      finished: false,
    });
    expect(gamesService.submitTurn).toHaveBeenCalledWith(1, 2, 'key.jpg');
  });

  it('expireCurrentTurn은 GamesService.expireCurrentTurn에 위임한다', async () => {
    gamesService.expireCurrentTurn.mockResolvedValue(null);

    await expect(handler.expireCurrentTurn(1)).resolves.toBeNull();
    expect(gamesService.expireCurrentTurn).toHaveBeenCalledWith(1);
  });

  it('getSessionState는 GamesService.getSessionState에 위임한다', async () => {
    gamesService.getSessionState.mockResolvedValue({ gameId: 1 });

    await expect(handler.getSessionState(1, 2)).resolves.toEqual({
      gameId: 1,
    });
    expect(gamesService.getSessionState).toHaveBeenCalledWith(1, 2);
  });

  it('findResumableSessions은 GamesService.findResumableSessions에 위임한다', async () => {
    gamesService.findResumableSessions.mockResolvedValue([]);

    await expect(handler.findResumableSessions()).resolves.toEqual([]);
    expect(gamesService.findResumableSessions).toHaveBeenCalled();
  });

  it('leaveActiveGame은 GamesService.leaveActiveGame에 위임한다', async () => {
    gamesService.leaveActiveGame.mockResolvedValue({
      gameId: 1,
      roomId: 2,
      leftUserId: 3,
    });

    await expect(handler.leaveActiveGame(1, 3)).resolves.toEqual({
      gameId: 1,
      roomId: 2,
      leftUserId: 3,
    });
    expect(gamesService.leaveActiveGame).toHaveBeenCalledWith(1, 3);
  });
});
