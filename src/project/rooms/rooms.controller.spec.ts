import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  NotFoundException,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';

// 인증 동작은 guard 대역으로 제어하고 Passport의 ESM 로딩을 분리한다.
jest.mock('../auth/security/jwt-auth-guard', () => ({
  JwtAuthGuard: class JwtAuthGuard {},
}));

describe('RoomsController', () => {
  let app: INestApplication<App>;
  const roomsService = {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
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
      controllers: [RoomsController],
      providers: [{ provide: RoomsService, useValue: roomsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/rooms/:roomId returns room details and parses the room ID', async () => {
    const response = { room: { id: 12 }, members: [{ userId: 3 }] };
    roomsService.findOne.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/rooms/12')
      .expect(200)
      .expect(response);
    expect(roomsService.findOne).toHaveBeenCalledWith(12, 3);
  });

  it('rejects non-integer room IDs before calling the service', async () => {
    await request(app.getHttpServer()).get('/api/rooms/invalid').expect(400);
    expect(roomsService.findOne).not.toHaveBeenCalled();
  });

  it('returns 404 when the service cannot find the room', async () => {
    roomsService.findOne.mockRejectedValue(
      new NotFoundException('방을 찾을 수 없습니다.'),
    );

    await request(app.getHttpServer()).get('/api/rooms/999').expect(404);
  });

  it('applies the existing authentication guard to room detail requests', async () => {
    authGuard.canActivate.mockReturnValue(false);

    await request(app.getHttpServer()).get('/api/rooms/12').expect(403);
    expect(roomsService.findOne).not.toHaveBeenCalled();
  });

  it('GET /api/rooms returns the room summary array', async () => {
    const rooms = [
      {
        id: 12,
        title: '대기방',
        status: 'WAITING',
        currentPlayers: 1,
        maxPlayers: 6,
      },
    ];
    roomsService.findAll.mockResolvedValue(rooms);

    await request(app.getHttpServer())
      .get('/api/rooms')
      .expect(200)
      .expect(rooms);
    expect(roomsService.create).not.toHaveBeenCalled();
  });

  it('returns 200 with an empty array when no room is available', async () => {
    roomsService.findAll.mockResolvedValue([]);

    await request(app.getHttpServer()).get('/api/rooms').expect(200).expect([]);
  });

  it('applies the existing authentication guard to the room list', async () => {
    authGuard.canActivate.mockReturnValue(false);

    await request(app.getHttpServer()).get('/api/rooms').expect(403);
    expect(roomsService.findAll).not.toHaveBeenCalled();
  });

  it('preserves POST /api/rooms and its creation response', async () => {
    const input = { title: '새 방' };
    const response = {
      room: { id: 12, title: '새 방' },
      members: [{ userId: 3 }],
    };
    roomsService.create.mockResolvedValue(response);

    await request(app.getHttpServer())
      .post('/api/rooms')
      .send(input)
      .expect(201)
      .expect(response);
    expect(roomsService.create).toHaveBeenCalledWith(3, input);
    expect(roomsService.findAll).not.toHaveBeenCalled();
  });
});
