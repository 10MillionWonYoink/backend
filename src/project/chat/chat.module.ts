import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatMessage } from './entities/chat-message.entity';
import { RoomsModule } from '../rooms/rooms.module';

@Module({
  imports: [TypeOrmModule.forFeature([ChatMessage]), RoomsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
