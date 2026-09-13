import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RoomsModule } from '../rooms/rooms.module';
import { GamesModule } from '../games/games.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeAuthService } from './security/realtime-auth.service';
import { LobbyRealtimeHandler } from './handlers/lobby-realtime.handler';
import { GameRealtimeHandler } from './handlers/game-realtime.handler';

@Module({
  imports: [AuthModule, RoomsModule, GamesModule],
  providers: [
    RealtimeGateway,
    RealtimeAuthService,
    LobbyRealtimeHandler,
    GameRealtimeHandler,
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
