import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateRoomDto } from './dto/create-room.dto';
import { randomBytes } from 'node:crypto';
import { Room, RoomStatus } from './entities/room.entity';
import { RoomMember } from './entities/room-member.entity';
import { DataSource, IsNull } from 'typeorm';
import { UpdateRoomDto } from './dto/update-room.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async findAll() {
    const roomRepository = this.dataSource.getRepository(Room);
    const rooms = await roomRepository.find({
      where: {
        status: RoomStatus.WAITING,
        isPublic: true,
      },
      relations: {
        members: true,
      },
      select: {
        id: true,
        title: true,
        maxParticipants: true,
        members: {
          id: true,
          leftAt: true,
        },
      },
      order: {
        createdAt: 'DESC',
        id: 'DESC',
      },
    });

    return rooms
      .map((room) => ({
        id: room.id,
        title: room.title,
        status: 'WAITING' as const,
        currentPlayers: room.members.filter((member) => member.leftAt === null)
          .length,
        maxPlayers: room.maxParticipants,
      }))
      .filter((room) => room.currentPlayers < room.maxPlayers);
  }

  async findMyAll(userId: number) {
    const roomRepository = this.dataSource.getRepository(Room);

    const rooms = await roomRepository
      .createQueryBuilder('room')
      .innerJoin(
        'room.members',
        'myMember',
        `
        myMember.userId = :userId
        AND myMember.leftAt IS NULL
      `,
        { userId },
      )
      .leftJoinAndSelect('room.members', 'members', 'members.leftAt IS NULL')
      // 게임이 끝나도 참여 기록(leftAt)은 남으므로, 1인 1게임방 정책은
      // '현재 진행 가능한' 방만 대상으로 한다. 종료된 방은 제외.
      .andWhere('room.status != :finishedStatus', {
        finishedStatus: RoomStatus.FINISHED,
      })
      .orderBy('room.createdAt', 'DESC')
      .addOrderBy('room.id', 'DESC')
      .getMany();

    return rooms.map((room) => ({
      id: room.id,
      title: room.title,
      status: room.status,
      currentPlayers: room.members.length,
      maxPlayers: room.maxParticipants,
    }));
  }

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

  async findOne(roomId: number, userId: number) {
    const roomRepository = this.dataSource.getRepository(Room);

    const room = await roomRepository
      .createQueryBuilder('room')

      // 요청한 사용자가 현재 방 참여자인지 검증
      .innerJoin(
        'room.members',
        'myMembership',
        `
        myMembership.userId = :userId
        AND myMembership.leftAt IS NULL
      `,
        { userId },
      )

      // 현재 방의 활성 참여자 조회
      .leftJoinAndSelect('room.members', 'members', 'members.leftAt IS NULL')
      .leftJoinAndSelect('members.user', 'memberUser')

      .where('room.id = :roomId', {
        roomId,
      })
      .orderBy('members.joinedAt', 'ASC')
      .addOrderBy('members.id', 'ASC')
      .getOne();

    if (!room) {
      this.logger.warn(
        JSON.stringify({
          event: 'room_access_failed',
          reason: 'not_active_room_member',
          roomId,
          userId,
        }),
      );

      throw new ForbiddenException('참여 중인 대기실이 아닙니다.');
    }

    const players = room.members.map((member) => ({
      memberId: member.id,
      userId: member.userId,
      nickname: member.user.nickname ?? '익명',
      profileImageUrl: member.user.profileImageUrl,
      isReady: member.isReady,
      isHost: member.userId === room.hostId,
    }));

    const host = players.find((player) => player.isHost);

    return {
      id: room.id,
      title: room.title,
      status: room.status,

      hostId: room.hostId,
      hostName: host?.nickname ?? '익명',

      minPlayers: room.minParticipants,
      maxPlayers: room.maxParticipants,
      currentPlayers: players.length,

      isPublic: room.isPublic,
      invitationCode: room.inviteCode,

      turnSeconds: room.timeLimitSeconds,
      totalRounds: room.relayCount,

      players,

      updatedAt: room.updatedAt,
    };
  }

  async leaveRoom(roomId: number, userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);

      const memberRepository = manager.getRepository(RoomMember);

      // 동시에 방장 변경이나 다른 퇴장이 발생하지 않도록 잠금
      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_leave_failed',
            reason: 'room_not_found',
            roomId,
            userId,
          }),
        );

        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_leave_failed',
            reason: 'room_not_waiting',
            roomId,
            userId,
            roomStatus: room.status,
          }),
        );

        throw new ConflictException('대기 중인 방에서만 나갈 수 있습니다.');
      }

      const leavingMember = await memberRepository.findOne({
        where: {
          roomId,
          userId,
          leftAt: IsNull(),
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!leavingMember) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_leave_failed',
            reason: 'active_member_not_found',
            roomId,
            userId,
          }),
        );

        throw new BadRequestException('현재 방에 참여 중인 사용자가 아닙니다.');
      }

      // 실제 삭제 대신 퇴장 시간 기록
      leavingMember.leftAt = new Date();
      leavingMember.isReady = false;
      leavingMember.turnOrder = null;

      await memberRepository.save(leavingMember);

      // 퇴장한 사용자를 제외한 나머지 활성 참여자
      const remainingMembers = await memberRepository
        .createQueryBuilder('member')
        .where('member.roomId = :roomId', {
          roomId,
        })
        .andWhere('member.leftAt IS NULL')
        .orderBy('member.joinedAt', 'ASC')
        .addOrderBy('member.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();

      // 남은 사람이 없으면 방 삭제
      if (remainingMembers.length === 0) {
        await roomRepository.remove(room);

        return {
          roomId,
          leftUserId: userId,
          currentParticipants: 0,
          roomDeleted: true,
          hostChanged: false,
          previousHostId: null,
          newHostId: null,
        };
      }

      let previousHostId: number | null = null;
      let newHostId: number | null = null;

      // 나가는 사람이 방장이면 가장 먼저 입장한 사람에게 이전
      if (room.hostId === userId) {
        const newHost = remainingMembers[0];

        previousHostId = room.hostId;
        newHostId = newHost.userId;

        room.hostId = newHost.userId;

        await roomRepository.save(room);
      }

      return {
        roomId,
        leftUserId: userId,
        currentParticipants: remainingMembers.length,
        roomDeleted: false,
        hostChanged: newHostId !== null,
        previousHostId,
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
        this.logger.warn(
          JSON.stringify({
            event: 'room_update_failed',
            reason: 'room_not_found',
            roomId,
            userId,
          }),
        );

        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.hostId !== userId) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_update_failed',
            reason: 'not_room_host',
            roomId,
            userId,
            hostId: room.hostId,
          }),
        );

        throw new ForbiddenException('방장만 방 설정을 변경할 수 있습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_update_failed',
            reason: 'room_not_waiting',
            roomId,
            userId,
            roomStatus: room.status,
          }),
        );

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
        this.logger.warn(
          JSON.stringify({
            event: 'room_update_failed',
            reason: 'minimum_exceeds_maximum',
            roomId,
            userId,
            minParticipants,
            maxParticipants,
          }),
        );

        throw new BadRequestException(
          '최소 인원은 최대 인원보다 클 수 없습니다.',
        );
      }

      if (maxParticipants < activeMemberCount) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_update_failed',
            reason: 'maximum_below_active_member_count',
            roomId,
            userId,
            maxParticipants,
            activeMemberCount,
          }),
        );

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
        this.logger.warn(
          JSON.stringify({
            event: 'room_host_change_failed',
            reason: 'room_not_found',
            roomId,
            currentUserId,
            newHostUserId,
          }),
        );

        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_host_change_failed',
            reason: 'room_not_waiting',
            roomId,
            currentUserId,
            newHostUserId,
            roomStatus: room.status,
          }),
        );

        throw new ConflictException(
          '대기 중인 방만 방장을 변경할 수 있습니다.',
        );
      }

      if (room.hostId !== currentUserId) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_host_change_failed',
            reason: 'not_current_host',
            roomId,
            currentUserId,
            newHostUserId,
            hostId: room.hostId,
          }),
        );

        throw new ForbiddenException('현재 방장만 방장을 변경할 수 있습니다.');
      }

      if (currentUserId === newHostUserId) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_host_change_failed',
            reason: 'same_host_selected',
            roomId,
            currentUserId,
            newHostUserId,
          }),
        );

        throw new BadRequestException('이미 현재 방장인 사용자입니다.');
      }

      const newHostMember = await roomMemberRepository.findOne({
        where: {
          roomId,
          userId: newHostUserId,
          leftAt: IsNull(),
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!newHostMember) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_host_change_failed',
            reason: 'new_host_not_active_member',
            roomId,
            currentUserId,
            newHostUserId,
          }),
        );

        throw new BadRequestException(
          '새 방장은 현재 방에 참여 중인 사용자여야 합니다.',
        );
      }

      const previousHostId = room.hostId;

      room.hostId = newHostUserId;

      await roomRepository.save(room);

      return {
        roomId,
        previousHostId,
        newHostId: newHostUserId,
        message: '방장이 변경되었습니다.',
      };
    });
  }

  async joinRoom(roomId: number, userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(Room);
      const roomMemberRepository = manager.getRepository(RoomMember);

      // 동시 입장으로 최대 인원을 초과하지 않도록 방을 잠금
      const room = await roomRepository.findOne({
        where: {
          id: roomId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!room) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_join_failed',
            reason: 'room_not_found',
            roomId,
            userId,
          }),
        );

        throw new NotFoundException('방을 찾을 수 없습니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_join_failed',
            reason: 'room_not_waiting',
            roomId,
            userId,
            roomStatus: room.status,
          }),
        );

        throw new ConflictException('대기 중인 방에만 참여할 수 있습니다.');
      }

      // (roomId, userId)는 유니크 제약이므로, 나갔다 돌아온 사용자의 행이
      // 이미 있는지 먼저 확인한다 (없으면 최초 참여).
      const existingMember = await roomMemberRepository.findOne({
        where: {
          roomId,
          userId,
        },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (existingMember && existingMember.leftAt === null) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_join_failed',
            reason: 'already_active_member',
            roomId,
            userId,
          }),
        );

        throw new ConflictException('이미 참여 중인 방입니다.');
      }

      const activeMemberCount = await roomMemberRepository.count({
        where: {
          roomId,
          leftAt: IsNull(),
        },
      });

      if (activeMemberCount >= room.maxParticipants) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_join_failed',
            reason: 'room_capacity_exceeded',
            roomId,
            userId,
            activeMemberCount,
            maxParticipants: room.maxParticipants,
          }),
        );

        throw new ConflictException('방의 최대 인원을 초과했습니다.');
      }

      let member: RoomMember;

      if (existingMember) {
        // 이전에 나갔던 사용자가 다시 참가 (같은 행 재사용)
        existingMember.leftAt = null;
        existingMember.isReady = false;
        existingMember.turnOrder = null;
        existingMember.joinedAt = new Date();

        member = await roomMemberRepository.save(existingMember);
      } else {
        // 최초 참여자는 새로운 행 생성
        const newMember = roomMemberRepository.create({
          roomId,
          userId,
          isReady: false,
          turnOrder: null,
          leftAt: null,
        });

        member = await roomMemberRepository.save(newMember);
      }

      return {
        message: '방에 참여했습니다.',
        roomId,
        memberId: member.id,
        alreadyJoined: false,
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
      this.logger.warn(
        JSON.stringify({
          event: 'room_invite_link_creation_failed',
          reason: 'room_not_found',
          roomId,
          userId,
        }),
      );

      throw new NotFoundException('방을 찾을 수 없습니다.');
    }

    if (room.status !== RoomStatus.WAITING) {
      this.logger.warn(
        JSON.stringify({
          event: 'room_invite_link_creation_failed',
          reason: 'room_not_waiting',
          roomId,
          userId,
          roomStatus: room.status,
        }),
      );

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
      this.logger.warn(
        JSON.stringify({
          event: 'room_invite_link_creation_failed',
          reason: 'not_active_room_member',
          roomId,
          userId,
        }),
      );

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
        this.logger.warn(
          JSON.stringify({
            event: 'room_invite_join_failed',
            reason: 'invalid_invite_code',
            userId,
          }),
        );

        throw new NotFoundException('유효하지 않은 초대 코드입니다.');
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_invite_join_failed',
            reason: 'room_not_waiting',
            roomId: room.id,
            userId,
            roomStatus: room.status,
          }),
        );

        throw new ConflictException('이미 시작되었거나 종료된 방입니다.');
      }

      const existingMember = await memberRepository.findOne({
        where: {
          roomId: room.id,
          userId,
        },
      });

      if (existingMember && existingMember.leftAt === null) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_invite_join_failed',
            reason: 'already_active_member',
            roomId: room.id,
            userId,
          }),
        );

        throw new ConflictException('이미 참여 중인 방입니다.');
      }

      const memberCount = await memberRepository.count({
        where: {
          roomId: room.id,
          leftAt: IsNull(),
        },
      });

      if (memberCount >= room.maxParticipants) {
        this.logger.warn(
          JSON.stringify({
            event: 'room_invite_join_failed',
            reason: 'room_capacity_exceeded',
            roomId: room.id,
            userId,
            activeMemberCount: memberCount,
            maxParticipants: room.maxParticipants,
          }),
        );

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

  async updateReady(roomId: number, userId: number, isReady: boolean) {
    const memberRepository = this.dataSource.getRepository(RoomMember);

    const result = await memberRepository.update(
      {
        roomId,
        userId,
        leftAt: IsNull(),
      },
      {
        isReady,
      },
    );

    if (result.affected === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'room_ready_update_failed',
          reason: 'active_member_not_found',
          roomId,
          userId,
          requestedReadyState: isReady,
        }),
      );

      throw new NotFoundException('현재 참여 중인 사용자가 아닙니다.');
    }

    return {
      roomId,
      userId,
      isReady,
    };
  }

  async findActiveMember(roomId: number, userId: number) {
    const memberRepository = this.dataSource.getRepository(RoomMember);

    const member = await memberRepository.findOne({
      where: {
        roomId,
        userId,
        leftAt: IsNull(),
      },
      relations: {
        user: true,
        room: true,
      },
      select: {
        id: true,
        userId: true,
        isReady: true,
        joinedAt: true,

        user: {
          id: true,
          nickname: true,
          profileImageUrl: true,
        },

        room: {
          id: true,
          hostId: true,
        },
      },
    });

    if (!member) {
      this.logger.warn(
        JSON.stringify({
          event: 'active_room_member_lookup_failed',
          reason: 'active_member_not_found',
          roomId,
          userId,
        }),
      );

      throw new ForbiddenException('현재 방에 참여 중인 사용자가 아닙니다.');
    }

    return {
      memberId: member.id,
      userId: member.userId,
      nickname: member.user.nickname ?? '익명',
      profileImageUrl: member.user.profileImageUrl,
      isReady: member.isReady,
      isHost: member.room.hostId === member.userId,
    };
  }
}
