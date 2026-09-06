import { ConflictException, Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}
  async create(createUserDto: CreateUserDto) {
    const { email, password, nickname, birthDate, profileImageUrl } =
      createUserDto;

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await this.usersRepository.findOne({
      where: [{ email: normalizedEmail }, { nickname }],
    });

    if (existingUser?.email === normalizedEmail) {
      throw new ConflictException('이미 사용 중인 이메일입니다.');
    }

    if (existingUser?.nickname === nickname) {
      throw new ConflictException('이미 사용 중인 닉네임입니다.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = this.usersRepository.create({
      email: normalizedEmail,
      passwordHash,
      nickname,
      birthDate: birthDate ?? null,
      profileImageUrl: profileImageUrl ?? null,
    });

    try {
      const savedUser = await this.usersRepository.save(user);

      return {
        id: savedUser.id,
        email: savedUser.email,
        nickname: savedUser.nickname,
        birthDate: savedUser.birthDate,
        profileImageUrl: savedUser.profileImageUrl,
        createdAt: savedUser.createdAt,
        updatedAt: savedUser.updatedAt,
      };
    } catch (error: unknown) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      ) {
        throw new ConflictException('이미 사용 중인 이메일 또는 닉네임입니다.');
      }

      throw error;
    }
  }

  findAll() {
    return this.usersRepository.find({
      select: {
        id: true,
        email: true,
        nickname: true,
        birthDate: true,
        profileImageUrl: true,
        createdAt: true,
        updatedAt: true,
      },
      order: {
        id: 'DESC',
      },
    });
  }

  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
