import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { AccessTokenPayload } from '../../auth/security/jwt-payload.interface';
import { parseCookie } from 'cookie';

@Injectable()
export class RealtimeAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async authenticate(client: Socket): Promise<number> {
    const cookieHeader = client.handshake.headers.cookie;

    if (!cookieHeader) {
      throw new UnauthorizedException('인증 쿠키가 없습니다.');
    }

    const cookies = parseCookie(cookieHeader);

    const accessToken = cookies.access_token;

    if (!accessToken) {
      throw new UnauthorizedException('Access Token이 없습니다.');
    }

    const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
      accessToken,
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      },
    );

    if (payload.type !== 'access' || !Number.isInteger(payload.sub)) {
      throw new UnauthorizedException('올바르지 않은 Access Token입니다.');
    }

    return payload.sub;
  }
}
