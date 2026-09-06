import { IsInt, Min } from 'class-validator';

export class ChangeRoomHostDto {
  @IsInt()
  @Min(1)
  newHostUserId: number;
}
