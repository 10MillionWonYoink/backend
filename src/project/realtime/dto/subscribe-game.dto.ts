import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class SubscribeGameDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  gameId: number;
}
