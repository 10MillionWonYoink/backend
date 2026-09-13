import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Min } from 'class-validator';

export class SubmitGameTurnDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  gameId: number;

  // S3 객체 Key (전체 URL이 아님)
  @IsString()
  @Length(1, 500)
  imageKey: string;
}
