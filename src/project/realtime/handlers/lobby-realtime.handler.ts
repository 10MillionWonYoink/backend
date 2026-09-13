import { Injectable } from '@nestjs/common';
import { RoomsService } from '../../rooms/rooms.service';
import { GamesService } from '../../games/games.service';
import { UpdateRoomDto } from '../../rooms/dto/update-room.dto';

@Injectable()
export class LobbyRealtimeHandler {
  constructor(
    private readonly roomsService: RoomsService,
    private readonly gamesService: GamesService,
  ) {}

  async subscribe(roomId: number, userId: number) {
    return this.roomsService.findLobbyStateForMember(roomId, userId);
  }

  async changeReady(roomId: number, userId: number, isReady: boolean) {
    return this.roomsService.updateReady(roomId, userId, isReady);
  }

  async updateRoom(
    roomId: number,
    userId: number,
    updateRoomDto: UpdateRoomDto,
  ) {
    return this.roomsService.update(roomId, userId, updateRoomDto);
  }

  async changeHost(
    roomId: number,
    currentUserId: number,
    newHostUserId: number,
  ) {
    return this.roomsService.changeHost(roomId, currentUserId, newHostUserId);
  }

  async leaveRoom(roomId: number, userId: number) {
    return this.roomsService.leaveRoom(roomId, userId);
  }
}
