import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateRoomDto } from './dto/create-room.dto';
import { randomBytes } from 'node:crypto';
import { Room, RoomStatus } from './entities/room.entity';
import { RoomMember } from './entities/room-member.entity';
import { DataSource, IsNull, Not } from 'typeorm';
import { UpdateRoomDto } from './dto/update-room.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RoomsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async create(userId: number, createRoomDto: CreateRoomDto) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);
      const roomMemberRepository = manager.getRepository(RoomMember);
      const room = roomRepository.create({
        title: createRoomDto.title,
        hostId: userId,
        maxParticipants: createRoomDto.maxParticipants ?? 10,
        isPublic: createRoomDto.isPublic ?? true,
        timeLimitSeconds: createRoomDto.timeLimitSeconds ?? 600,
        relayCount: createRoomDto.relayCount ?? 10,
        inviteCode: this.generateInviteCode(),
        status: RoomStatus.WAITING,
      });

      const savedRoom = await roomRepository.save(room);

      // 방장을 참여자 목록에도 추가
      const hostMember = roomMemberRepository.create({
        roomId: savedRoom.id,
        userId,
        isReady: false,
        turnOrder: null,
        leftAt: null,
      });

      const savedHostMember = await roomMemberRepository.save(hostMember);

      return {
        room: savedRoom,
        members: [savedHostMember],
      };
    });
  }

  async leave(roomId: number, userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const roomMemberRepository = manager.getRepository(RoomMember);

      // 동일한 방에서 동시에 탈퇴·방장 변경이 발생하지 않도록 잠금
      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('방을 찾을 수 없습니다.');
      }
      if (room.status !== RoomStatus.WAITING) {
        throw new ConflictException(
          '게임 대기 중에만 방에서 나갈 수 있습니다.',
        );
      }
      const member = await roomMemberRepository.findOne({
        where: {
          roomId,
          userId,
          leftAt: IsNull(),
        },
      });

      if (!member) {
        throw new NotFoundException('현재 방에 참여 중인 사용자가 아닙니다.');
      }

      // 나가는 사용자를 제외한 활성 멤버
      const remainingMembers = await roomMemberRepository.find({
        where: {
          roomId,
          userId: Not(userId),
          leftAt: IsNull(),
        },
        order: {
          joinedAt: 'ASC',
          id: 'ASC',
        },
      });

      const isHost = room.hostId === userId;

      // 방장 혼자 남아 있던 경우 방 삭제
      if (isHost && remainingMembers.length === 0) {
        await roomRepository.remove(room);

        return {
          message: '방이 삭제되었습니다.',
          roomId,
          roomDeleted: true,
          newHostId: null,
        };
      }

      // 탈퇴 상태 기록
      member.leftAt = new Date();
      member.isReady = false;
      member.turnOrder = null;

      await roomMemberRepository.save(member);

      let newHostId: number | null = null;

      // 방장이 나가면 가장 먼저 들어온 멤버에게 방장 위임
      if (isHost) {
        const nextHost = remainingMembers[0];

        room.hostId = nextHost.userId;
        newHostId = nextHost.userId;

        await roomRepository.save(room);
      }

      return {
        message: '방에서 나갔습니다.',
        roomId,
        roomDeleted: false,
        newHostId,
      };
    });
  }

  async update(
    roomId: number,
    userId: number,
    updateRoomDto: UpdateRoomDto,
  ): Promise<Room> {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const roomMemberRepository = manager.getRepository(RoomMember);

      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.hostId !== userId) {
        throw new ForbiddenException('방장만 방 설정을 변경할 수 있습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        throw new ConflictException('대기 중인 방만 변경할 수 있습니다.');
      }

      const activeMemberCount = await roomMemberRepository.count({
        where: {
          roomId,
          leftAt: IsNull(),
        },
      });

      const minParticipants =
        updateRoomDto.minParticipants ?? room.minParticipants;

      const maxParticipants =
        updateRoomDto.maxParticipants ?? room.maxParticipants;

      if (minParticipants > maxParticipants) {
        throw new BadRequestException(
          '최소 인원은 최대 인원보다 클 수 없습니다.',
        );
      }

      if (maxParticipants < activeMemberCount) {
        throw new BadRequestException(
          '최대 인원을 현재 참여자 수보다 작게 설정할 수 없습니다.',
        );
      }

      if (updateRoomDto.title !== undefined) {
        room.title = updateRoomDto.title.trim();
      }

      room.minParticipants = minParticipants;
      room.maxParticipants = maxParticipants;

      if (updateRoomDto.isPublic !== undefined) {
        room.isPublic = updateRoomDto.isPublic;
      }

      if (updateRoomDto.relayCount !== undefined) {
        room.relayCount = updateRoomDto.relayCount;
      }

      if (updateRoomDto.timeLimitSeconds !== undefined) {
        room.timeLimitSeconds = updateRoomDto.timeLimitSeconds;
      }

      return roomRepository.save(room);
    });
  }

  async changeHost(
    roomId: number,
    currentUserId: number,
    newHostUserId: number,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const roomMemberRepository = manager.getRepository(RoomMember);

      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        throw new ConflictException(
          '대기 중인 방만 방장을 변경할 수 있습니다.',
        );
      }

      if (room.hostId !== currentUserId) {
        throw new ForbiddenException('현재 방장만 방장을 변경할 수 있습니다.');
      }

      if (currentUserId === newHostUserId) {
        throw new BadRequestException('이미 현재 방장인 사용자입니다.');
      }

      const newHostMember = await roomMemberRepository.findOne({
        where: {
          roomId,
          userId: newHostUserId,
          leftAt: IsNull(),
        },
      });

      if (!newHostMember) {
        throw new BadRequestException(
          '새 방장은 현재 방에 참여 중인 사용자여야 합니다.',
        );
      }

      const previousHostId = room.hostId;

      room.hostId = newHostUserId;

      await roomRepository.save(room);

      return {
        message: '방장이 변경되었습니다.',
        roomId,
        previousHostId,
        newHostId: newHostUserId,
      };
    });
  }
  async getInviteLink(roomId: number, userId: number) {
    const roomRepository = this.dataSource.getRepository(Room);

    const roomMemberRepository = this.dataSource.getRepository(RoomMember);

    const room = await roomRepository.findOneBy({
      id: roomId,
    });

    if (!room) {
      throw new NotFoundException('방을 찾을 수 없습니다.');
    }

    if (room.status !== RoomStatus.WAITING) {
      throw new ConflictException('대기 중인 방만 초대할 수 있습니다.');
    }

    const member = await roomMemberRepository.findOne({
      where: {
        roomId,
        userId,
        leftAt: IsNull(),
      },
    });

    if (!member) {
      throw new ForbiddenException(
        '방에 참여 중인 사용자만 초대할 수 있습니다.',
      );
    }

    if (!room.inviteCode) {
      room.inviteCode = this.generateInviteCode();

      await roomRepository.save(room);
    }

    const frontendUrl = this.configService
      .getOrThrow<string>('FRONTEND_URL')
      .replace(/\/$/, '');

    return {
      roomId: room.id,
      inviteCode: room.inviteCode,
      inviteUrl: `${frontendUrl}/rooms/join/${room.inviteCode}`,
    };
  }

  async joinByInviteCode(inviteCode: string, userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const memberRepository = manager.getRepository(RoomMember);

      const room = await roomRepository.findOne({
        where: {
          inviteCode,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        throw new NotFoundException('유효하지 않은 초대 코드입니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        throw new ConflictException('이미 시작되었거나 종료된 방입니다.');
      }

      const existingMember = await memberRepository.findOne({
        where: {
          roomId: room.id,
          userId,
        },
      });

      if (existingMember && existingMember.leftAt === null) {
        throw new ConflictException('이미 참여 중인 방입니다.');
      }

      const memberCount = await memberRepository.count({
        where: {
          roomId: room.id,
          leftAt: IsNull(),
        },
      });

      if (memberCount >= room.maxParticipants) {
        throw new ConflictException('방의 최대 인원을 초과했습니다.');
      }

      let member: RoomMember;

      // 이전에 나갔던 사용자가 다시 참가
      if (existingMember) {
        existingMember.leftAt = null;
        existingMember.isReady = false;
        existingMember.turnOrder = null;
        existingMember.joinedAt = new Date();

        member = await memberRepository.save(existingMember);
      } else {
        member = memberRepository.create({
          roomId: room.id,
          userId,
          isReady: false,
          turnOrder: null,
          leftAt: null,
        });

        member = await memberRepository.save(member);
      }

      return {
        message: '방에 참가했습니다.',
        roomId: room.id,
        member,
      };
    });
  }

  private generateInviteCode(): string {
    return randomBytes(8).toString('hex');
  }
}
