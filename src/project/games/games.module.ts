import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GamesGateway } from './games/games.gateway';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoomsModule } from '../rooms/rooms.module';
import { GameSession } from './entities/game-session.entity';
import { GameTurn } from './entities/game-turn.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GameSession, GameTurn]), RoomsModule],
  controllers: [GamesController],
  providers: [GamesService, GamesGateway],
  exports: [GamesService],
})
export class GamesModule {}
