import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { GamesService } from './games.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';
import { GetMyGameHistoryDto } from './dto/get-my-game-history.dto';

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

  // 내 게임 기록(과거 참여했던 종료된 게임) 목록 조회.
  // 동적 세그먼트(:gameId)보다 먼저 선언해야 "my"가 gameId로 잘못 매칭되지 않는다.
  @Get('my')
  findMyGameHistory(
    @GetUser() user: User,
    @Query() query: GetMyGameHistoryDto,
  ) {
    return this.gamesService.findMyGameHistory(user.id, {
      limit: query.limit,
      offset: query.offset,
    });
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
