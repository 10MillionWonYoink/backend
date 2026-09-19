import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendGlobalChatMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  content: string;
}
