import { Injectable } from '@nestjs/common';
import { GamesService } from '../../games/games.service';

@Injectable()
export class GameRealtimeHandler {
  constructor(private readonly gamesService: GamesService) {}
}
