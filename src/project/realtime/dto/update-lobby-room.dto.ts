import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateRoomDto } from '../../rooms/dto/update-room.dto';

export class UpdateLobbyRoomDto extends UpdateRoomDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roomId: number;
}
