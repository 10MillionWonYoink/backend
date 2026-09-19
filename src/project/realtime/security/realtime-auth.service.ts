import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { AccessTokenPayload } from '../../auth/security/jwt-payload.interface';
import * as cookie from 'cookie';

type CookieParser = (
  cookieHeader: string,
) => Record<string, string | undefined>;

const cookieModule = cookie as unknown as {
  parse?: CookieParser;
  parseCookie?: CookieParser;
};

function parseCookieHeader(cookieHeader: string) {
  const parser = cookieModule.parseCookie ?? cookieModule.parse;

  if (!parser) {
    throw new TypeError('Cookie parser is unavailable');
  }

  return parser(cookieHeader);
}

@Injectable()
export class RealtimeAuthService {
  private readonly logger = new Logger(RealtimeAuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async authenticate(client: Socket): Promise<number> {
    const cookieHeader = client.handshake.headers.cookie;

    if (!cookieHeader) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime_authentication_failed',
          reason: 'cookie_header_missing',
          socketId: client.id,
        }),
      );

      throw new UnauthorizedException('인증 쿠키가 없습니다.');
    }

    let cookies: Record<string, string | undefined>;

    try {
      cookies = parseCookieHeader(cookieHeader);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'realtime_authentication_failed',
          reason: 'cookie_parsing_failed',
          socketId: client.id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }

    const accessToken = cookies.access_token;

    if (!accessToken) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime_authentication_failed',
          reason: 'access_token_missing',
          socketId: client.id,
        }),
      );

      throw new UnauthorizedException('Access Token이 없습니다.');
    }

    let payload: AccessTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        accessToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        },
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime_authentication_failed',
          reason: 'access_token_verification_failed',
          socketId: client.id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );

      throw error;
    }

    if (payload.type !== 'access' || !Number.isInteger(payload.sub)) {
      this.logger.warn(
        JSON.stringify({
          event: 'realtime_authentication_failed',
          reason: 'invalid_access_token_payload',
          socketId: client.id,
          tokenType: payload.type,
          hasValidSubject: Number.isInteger(payload.sub),
        }),
      );

      throw new UnauthorizedException('올바르지 않은 Access Token입니다.');
    }

    return payload.sub;
  }
}
