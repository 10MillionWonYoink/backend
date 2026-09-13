import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { In, Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async devLogin(accountNumber: number, response: Response) {
    this.validateDevLogin();

    if (accountNumber < 1 || accountNumber > 10) {
      throw new BadRequestException(
        '테스트 계정 번호는 1부터 10까지 사용할 수 있습니다.',
      );
    }

    await this.createDevUsers();

    const kakaoUserId = this.getDevKakaoUserId(accountNumber);

    const user = await this.userRepository.findOne({
      where: {
        kakaoUserId,
      },
    });

    if (!user) {
      throw new NotFoundException('테스트 계정을 찾을 수 없습니다.');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      type: 'access',
    });

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';

    response.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    return {
      message: `${user.nickname} 계정으로 로그인했습니다.`,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
      },
    };
  }

  async createDevUsers(): Promise<User[]> {
    this.validateDevLogin();

    const devAccounts = Array.from({ length: 10 }, (_, index) => {
      const accountNumber = index + 1;

      return {
        kakaoUserId: this.getDevKakaoUserId(accountNumber),
        email: `dev-user-${accountNumber}@photo-relay.local`,
        nickname: `테스트유저${accountNumber}`,
        profileImageUrl: null,
        birthDate: null,
        registrationCompleted: true,
      };
    });

    await this.userRepository.upsert(devAccounts, {
      conflictPaths: ['kakaoUserId'],
      skipUpdateIfNoValuesChanged: true,
    });

    return this.userRepository.find({
      where: {
        kakaoUserId: In(devAccounts.map((account) => account.kakaoUserId)),
      },
      order: {
        id: 'ASC',
      },
    });
  }

  findById(userId: number): Promise<User | null> {
    return this.userRepository.findOne({
      where: {
        id: userId,
      },
    });
  }

  private getDevKakaoUserId(accountNumber: number): string {
    return `dev-user-${accountNumber.toString().padStart(2, '0')}`;
  }

  private validateDevLogin(): void {
    const nodeEnv = this.configService.get<string>('NODE_ENV');

    const enabled =
      this.configService.get<string>('DEV_LOGIN_ENABLED') === 'true';

    if (nodeEnv === 'production' || !enabled) {
      throw new NotFoundException();
    }
  }
}
