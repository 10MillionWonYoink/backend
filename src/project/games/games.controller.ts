import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { GamesService } from './games.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('games')
@UseGuards(JwtAuthGuard)
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  // 방 기준 가장 최근 게임 조회 (재접속 시 진입점)
  @Get('rooms/:roomId/latest')
  findLatestByRoom(
    @Param('roomId', ParseIntPipe) roomId: number,
    @GetUser() user: User,
  ) {
    return this.gamesService.findLatestGameByRoom(roomId, user.id);
  }

  // 게임 진행 화면(재접속 포함)에 필요한 세션/턴 현황 조회
  @Get(':gameId')
  findOne(
    @Param('gameId', ParseIntPipe) gameId: number,
    @GetUser() user: User,
  ) {
    return this.gamesService.getSessionState(gameId, user.id);
  }

  // 게임 결과 조회
  @Get(':gameId/result')
  findResult(
    @Param('gameId', ParseIntPipe) gameId: number,
    @GetUser() user: User,
  ) {
    return this.gamesService.getResult(gameId, user.id);
  }
}
