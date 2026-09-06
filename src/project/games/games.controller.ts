import {
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';
import { GamesService } from './games.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GamesGateway } from './games/games.gateway';

@Controller()
@UseGuards(JwtAuthGuard)
export class GamesController {
  constructor(
    private readonly gamesService: GamesService,
    private readonly gamesGateway: GamesGateway,
  ) {}

  @Post('rooms/:roomId/games')
  async startGame(
    @Param('roomId', ParseIntPipe)
    roomId: number,

    @GetUser()
    user: User,
  ) {
    const game = await this.gamesService.startGame(roomId, user.id);

    this.gamesGateway.startCountdown(game);

    return game;
  }
}
