import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class LeaveLobbyDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roomId: number;
}
