import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';
import { GetChatMessagesDto } from './dto/get-chat-messages.dto';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // 전체 채팅 메시지 기록 조회 (채팅창 최초 진입 시 사용)
  @Get('global')
  findGlobalMessages(
    @GetUser() user: User,
    @Query() query: GetChatMessagesDto,
  ) {
    return this.chatService.findGlobalMessages(user.id, {
      limit: query.limit,
      beforeId: query.beforeId,
    });
  }

  // 게임방 채팅 메시지 기록 조회 (현재 활성 참여자만 조회 가능)
  @Get('rooms/:roomId')
  findRoomMessages(
    @Param('roomId', ParseIntPipe) roomId: number,
    @GetUser() user: User,
    @Query() query: GetChatMessagesDto,
  ) {
    return this.chatService.findRoomMessages(roomId, user.id, {
      limit: query.limit,
      beforeId: query.beforeId,
    });
  }
}
