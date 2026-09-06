import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(10)
  minParticipants?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(10)
  maxParticipants?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  relayCount?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  timeLimitSeconds?: number;
}
