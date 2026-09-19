import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';

jest.mock('../auth/security/jwt-auth-guard', () => ({
  JwtAuthGuard: class JwtAuthGuard {},
}));

describe('ChatController', () => {
  let app: INestApplication<App>;
  const chatService = {
    findGlobalMessages: jest.fn(),
    findRoomMessages: jest.fn(),
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
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chatService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/chat/global 은 전체 채팅 기록을 조회한다', async () => {
    const response = [
      {
        id: 1,
        roomId: null,
        userId: 3,
        nickname: '수연',
        profileImageUrl: null,
        content: '안녕',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    chatService.findGlobalMessages.mockResolvedValue(response);

    await request(app.getHttpServer())
      .get('/api/chat/global')
      .expect(200)
      .expect(response);
    expect(chatService.findGlobalMessages).toHaveBeenCalledWith(3, {
      limit: undefined,
      beforeId: undefined,
    });
  });

  it('GET /api/chat/global?limit=&beforeId= 쿼리를 숫자로 변환해 전달한다', async () => {
    chatService.findGlobalMessages.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get('/api/chat/global?limit=10&beforeId=5')
      .expect(200);
    expect(chatService.findGlobalMessages).toHaveBeenCalledWith(3, {
      limit: 10,
      beforeId: 5,
    });
  });

  it('GET /api/chat/rooms/:roomId 는 방 채팅 기록을 조회한다', async () => {
    chatService.findRoomMessages.mockResolvedValue([]);

    await request(app.getHttpServer()).get('/api/chat/rooms/7').expect(200);
    expect(chatService.findRoomMessages).toHaveBeenCalledWith(7, 3, {
      limit: undefined,
      beforeId: undefined,
    });
  });

  it('숫자가 아닌 roomId는 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .get('/api/chat/rooms/invalid')
      .expect(400);
    expect(chatService.findRoomMessages).not.toHaveBeenCalled();
  });

  it('인증 guard를 통과하지 못하면 403을 반환한다', async () => {
    authGuard.canActivate.mockReturnValue(false);

    await request(app.getHttpServer()).get('/api/chat/global').expect(403);
    expect(chatService.findGlobalMessages).not.toHaveBeenCalled();
  });
});
