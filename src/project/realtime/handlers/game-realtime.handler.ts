import { Injectable } from '@nestjs/common';
import { GamesService } from '../../games/games.service';

@Injectable()
export class GameRealtimeHandler {
  constructor(private readonly gamesService: GamesService) {}

  async startGame(roomId: number, userId: number) {
    return this.gamesService.startGame(roomId, userId);
  }

  async beginFirstTurn(gameId: number) {
    return this.gamesService.beginFirstTurn(gameId);
  }

  async submitTurn(gameId: number, userId: number, imageKey: string) {
    return this.gamesService.submitTurn(gameId, userId, imageKey);
  }

  async expireCurrentTurn(gameId: number) {
    return this.gamesService.expireCurrentTurn(gameId);
  }

  async getSessionState(gameId: number, userId: number) {
    return this.gamesService.getSessionState(gameId, userId);
  }

  async findResumableSessions() {
    return this.gamesService.findResumableSessions();
  }

  async leaveActiveGame(gameId: number, userId: number) {
    return this.gamesService.leaveActiveGame(gameId, userId);
  }
}
