import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ExecutionContext,
  ConflictException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';

// 인증 동작은 guard 대역으로 제어하고 Passport의 ESM 로딩을 분리한다.
jest.mock('../auth/security/jwt-auth-guard', () => ({
  JwtAuthGuard: class JwtAuthGuard {},
}));

describe('GamesController', () => {
  let app: INestApplication<App>;
  const gamesService = {
    findLatestGameByRoom: jest.fn(),
    getSessionState: jest.fn(),
    getResult: jest.fn(),
    findMyGameHistory: jest.fn(),
  };
  const authGuard = { canActivate: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    authGuard.canActivate.mockImplementation((context: ExecutionContext) => {
      context.switchToHttp().getRequest<{ user: { id: number } }>().user = {
        id: 3,
      };
      return true;
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GamesController],
      providers: [{ provide: GamesService, useValue: gamesService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    // main.ts와 동일한 전역 ValidationPipe (query DTO 검증을 실제로 검증하기 위함).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/games/rooms/:roomId/latest 는 방의 최신 게임을 조회한다', async () => {
    const response = { gameId: 7, roomId: 12, status: 'in_progress' };
    gamesService.findLatestGameByRoom.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/games/rooms/12/latest')
      .expect(200)
      .expect(response);
    expect(gamesService.findLatestGameByRoom).toHaveBeenCalledWith(12, 3);
  });

  it('GET /api/games/:gameId 는 세션 상태를 조회한다', async () => {
    const response = { gameId: 7, status: 'in_progress' };
    gamesService.getSessionState.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/games/7')
      .expect(200)
      .expect(response);
    expect(gamesService.getSessionState).toHaveBeenCalledWith(7, 3);
  });

  it('GET /api/games/:gameId/result 는 결과를 조회한다', async () => {
    const response = { gameId: 7, status: 'finished', turns: [] };
    gamesService.getResult.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/games/7/result')
      .expect(200)
      .expect(response);
    expect(gamesService.getResult).toHaveBeenCalledWith(7, 3);
  });

  it('종료되지 않은 게임의 결과 조회는 409를 반환한다', async () => {
    gamesService.getResult.mockRejectedValue(
      new ConflictException('아직 종료되지 않은 게임입니다.'),
    );

    await request(app.getHttpServer()).get('/api/games/7/result').expect(409);
  });

  it('방 참여자가 아니면 403을 반환한다', async () => {
    gamesService.getSessionState.mockRejectedValue(
      new ForbiddenException('해당 게임에 접근할 권한이 없습니다.'),
    );

    await request(app.getHttpServer()).get('/api/games/7').expect(403);
  });

  it('GET /api/games/my 는 내 게임 기록 목록을 조회한다 (gameId 동적 라우트보다 우선 매칭)', async () => {
    const response = {
      games: [
        {
          gameId: 7,
          roomId: 12,
          roomTitle: '테스트 방',
          finishedAt: '2026-01-01T00:10:00.000Z',
          participants: [
            { userId: 3, nickname: '수연', profileImageUrl: null },
          ],
          myScore: 80,
          myRank: 1,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    };
    gamesService.findMyGameHistory.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/games/my')
      .expect(200)
      .expect(response);
    expect(gamesService.findMyGameHistory).toHaveBeenCalledWith(3, {
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/games/my 는 limit/offset 쿼리를 숫자로 변환해 전달한다', async () => {
    gamesService.findMyGameHistory.mockResolvedValue({
      games: [],
      total: 0,
      limit: 5,
      offset: 10,
    });

    await request(app.getHttpServer())
      .get('/api/games/my?limit=5&offset=10')
      .expect(200);
    expect(gamesService.findMyGameHistory).toHaveBeenCalledWith(3, {
      limit: 5,
      offset: 10,
    });
  });

  it('GET /api/games/my 는 limit 범위를 벗어나면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .get('/api/games/my?limit=999')
      .expect(400);
    expect(gamesService.findMyGameHistory).not.toHaveBeenCalled();
  });

  it('숫자가 아닌 gameId는 400을 반환한다', async () => {
    await request(app.getHttpServer()).get('/api/games/invalid').expect(400);
    expect(gamesService.getSessionState).not.toHaveBeenCalled();
  });

  it('인증 guard를 통과하지 못하면 403을 반환한다', async () => {
    authGuard.canActivate.mockReturnValue(false);

    await request(app.getHttpServer()).get('/api/games/7').expect(403);
    expect(gamesService.getSessionState).not.toHaveBeenCalled();
  });
});
