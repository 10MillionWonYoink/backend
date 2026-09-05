import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AccessTokenPayload } from './jwt-payload.interface';

function extractAccessTokenFromCookie(request: Request): string | null {
  const token: unknown = request.cookies?.access_token;

  return typeof token === 'string' ? token : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        extractAccessTokenFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),

      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),

      ignoreExpiration: false,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<User> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('올바르지 않은 토큰입니다.');
    }

    const user = await this.userRepository.findOneBy({
      id: payload.sub,
    });

    if (!user) {
      throw new UnauthorizedException('사용자를 찾을 수 없습니다.');
    }

    if (!user.registrationCompleted) {
      throw new UnauthorizedException('회원가입이 완료되지 않았습니다.');
    }

    return user;
  }
}
