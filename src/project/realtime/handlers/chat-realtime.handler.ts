import { Injectable } from '@nestjs/common';
import { ChatService } from '../../chat/chat.service';

@Injectable()
export class ChatRealtimeHandler {
  constructor(private readonly chatService: ChatService) {}

  async sendGlobalMessage(userId: number, content: string) {
    return this.chatService.sendGlobalMessage(userId, content);
  }

  async sendRoomMessage(roomId: number, userId: number, content: string) {
    return this.chatService.sendRoomMessage(roomId, userId, content);
  }
}
