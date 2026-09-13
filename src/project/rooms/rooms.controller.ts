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
  Req,
} from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';
import { UpdateRoomDto } from './dto/update-room.dto';
import { ChangeRoomHostDto } from './dto/change-room-host.dto';
import { AccessTokenPayload } from '../auth/security/jwt-payload.interface';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  // 참여 가능한 룸 목록 조회
  @Get()
  findAll() {
    return this.roomsService.findAll();
  }

  // 내가 참여한 룸 목록 조회
  @Get('my')
  findMyRoomList(
    @Req()
    req: Request & {
      user: AccessTokenPayload;
    },
  ) {
    return this.roomsService.findMyAll(req.user.sub);
  }

  // 룸 생성
  @Post()
  create(@GetUser() user: User, @Body() createRoomDto: CreateRoomDto) {
    return this.roomsService.create(user.id, createRoomDto);
  }

  // 룸 상세 조회
  @Get(':roomId')
  findOne(@Param('roomId', ParseIntPipe) roomId: number) {
    return this.roomsService.findOne(roomId);
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
    return this.roomsService.leaveRoom(roomId, user.id);
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
