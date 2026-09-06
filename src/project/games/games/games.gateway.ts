import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { GamesService } from '../games.service';

@WebSocketGateway({
  namespace: '/games',
  cors: {
    origin: process.env.FRONTEND_URL,
    credentials: true,
  },
})
export class GamesGateway {
  @WebSocketServer()
  server: Server;

  constructor(private readonly gamesService: GamesService) {}

  startCountdown(game: {
    gameId: number;
    roomId: number;
    countdownEndsAt: Date;
  }): void {
    const socketRoom = `room:${game.roomId}`;

    this.server.to(socketRoom).emit('game:countdown', {
      gameId: game.gameId,
      countdownEndsAt: game.countdownEndsAt,
    });

    const delay = Math.max(game.countdownEndsAt.getTime() - Date.now(), 0);

    setTimeout(() => {
      void this.beginGame(game.gameId, game.roomId);
    }, delay);
  }

  private async beginGame(gameId: number, roomId: number): Promise<void> {
    const firstTurn = await this.gamesService.beginFirstTurn(gameId);

    if (!firstTurn) {
      return;
    }

    this.server.to(`room:${roomId}`).emit('turn:started', firstTurn);
  }
}
