import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
  private readonly logger = new Logger(JwtStrategy.name);

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
      this.logger.warn(
        JSON.stringify({
          event: 'access_token_validation_failed',
          reason: 'invalid_token_type',
          userId: payload.sub,
          tokenType: payload.type,
        }),
      );

      throw new UnauthorizedException('올바르지 않은 토큰입니다.');
    }

    const user = await this.userRepository.findOneBy({
      id: payload.sub,
    });

    if (!user) {
      this.logger.warn(
        JSON.stringify({
          event: 'access_token_validation_failed',
          reason: 'user_not_found',
          userId: payload.sub,
        }),
      );

      throw new UnauthorizedException('사용자를 찾을 수 없습니다.');
    }

    if (!user.registrationCompleted) {
      this.logger.warn(
        JSON.stringify({
          event: 'access_token_validation_failed',
          reason: 'signup_not_completed',
          userId: user.id,
        }),
      );

      throw new UnauthorizedException('회원가입이 완료되지 않았습니다.');
    }

    return user;
  }
}
