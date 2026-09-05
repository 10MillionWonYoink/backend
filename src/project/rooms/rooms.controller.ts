import {
  Controller,
  Post,
  Body,
  UseGuards,
  Patch,
  Param,
  ParseIntPipe,
  HttpCode,
  Get,
} from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';
import { UpdateRoomDto } from './dto/update-room.dto';
import { ChangeRoomHostDto } from './dto/change-room-host.dto';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  // 룸 생성
  @Post()
  create(@GetUser() user: User, @Body() createRoomDto: CreateRoomDto) {
    return this.roomsService.create(user.id, createRoomDto);
  }

  // 룸 탈퇴
  @Post(':roomId/leave')
  @HttpCode(200)
  leave(
    @Param('roomId', ParseIntPipe)
    roomId: number,

    @GetUser()
    user: User,
  ) {
    return this.roomsService.leave(roomId, user.id);
  }

  // 룸 정보 변경
  @Patch(':roomId')
  update(
    @Param('roomId', ParseIntPipe)
    roomId: number,
    @GetUser()
    user: User,
    @Body()
    updateRoomDto: UpdateRoomDto,
  ) {
    return this.roomsService.update(roomId, user.id, updateRoomDto);
  }

  // 방장 변경
  @Patch(':roomId/host')
  changeHost(
    @Param('roomId', ParseIntPipe)
    roomId: number,

    @GetUser()
    user: User,

    @Body()
    changeRoomHostDto: ChangeRoomHostDto,
  ) {
    return this.roomsService.changeHost(
      roomId,
      user.id,
      changeRoomHostDto.newHostUserId,
    );
  }

  // 방 초대
  @Get(':roomId/invite')
  getInviteLink(
    @Param('roomId', ParseIntPipe)
    roomId: number,

    @GetUser()
    user: User,
  ) {
    return this.roomsService.getInviteLink(roomId, user.id);
  }

  // 방 참여
  @Post('invites/:inviteCode/join')
  joinByInviteCode(
    @Param('inviteCode')
    inviteCode: string,

    @GetUser()
    user: User,
  ) {
    return this.roomsService.joinByInviteCode(inviteCode, user.id);
  }
}
