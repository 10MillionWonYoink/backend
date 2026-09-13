import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoomsModule } from '../rooms/rooms.module';
import { AiModule } from '../ai/ai.module';
import { GameSession } from './entities/game-session.entity';
import { GameTurn } from './entities/game-turn.entity';
import { ImageUrlResolver } from './image-url.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([GameSession, GameTurn]),
    RoomsModule,
    AiModule,
  ],
  controllers: [GamesController],
  providers: [GamesService, ImageUrlResolver],
  exports: [GamesService],
})
export class GamesModule {}
