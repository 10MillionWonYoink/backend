import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { SignupDto } from './dto/signup.dto';
import { KakaoTokenResponse } from './res/kakao-token-response';
import { KakaoProfileResponse } from './res/kakao-profile-response';
import {
  AccessTokenPayload,
  RefreshTokenPayload,
  SignupTokenPayload,
} from './security/jwt-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 카카오 로그인 페이지 주소 생성
   */
  createKakaoAuthorizationUrl(): string {
    const restApiKey =
      this.configService.getOrThrow<string>('KAKAO_REST_API_KEY');

    const redirectUri =
      this.configService.getOrThrow<string>('KAKAO_REDIRECT_URI');

    const url = new URL('https://kauth.kakao.com/oauth/authorize');

    url.searchParams.set('client_id', restApiKey);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'profile_nickname,profile_image'); // 기존 사용자에게 추가 동의 요청

    return url.toString();
  }

  /**
   * 카카오 인가 코드를 카카오 토큰으로 교환
   */
  async getKakaoToken(code: string) {
    const restApiKey =
      this.configService.getOrThrow<string>('KAKAO_REST_API_KEY');

    const redirectUri =
      this.configService.getOrThrow<string>('KAKAO_REDIRECT_URI');

    const clientSecret = this.configService.get<string>('KAKAO_CLIENT_SECRET');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: restApiKey,
      redirect_uri: redirectUri,
      code,
    });

    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }

    const response = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body,
    });

    if (!response.ok) {
      const kakaoError = await response.text();

      throw new BadGatewayException({
        message: '카카오 토큰 발급에 실패했습니다.',
        kakaoError,
      });
    }

    return (await response.json()) as KakaoTokenResponse;
  }

  async getKakaoProfile(
    kakaoAccessToken: string,
  ): Promise<KakaoProfileResponse> {
    const response = await fetch('https://kapi.kakao.com/v2/user/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${kakaoAccessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
    });

    if (!response.ok) {
      const kakaoError = await response.text();

      throw new BadGatewayException({
        message: '카카오 사용자 조회에 실패했습니다.',
        kakaoError,
      });
    }

    return (await response.json()) as KakaoProfileResponse;
  }

  /**
   * 카카오 회원번호로 우리 서비스 회원 조회
   */
  async findByKakaoUserId(kakaoUserId: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: {
        kakaoUserId,
      },
    });
  }

  /**
   * 카카오 인증은 완료했지만
   * 우리 서비스 가입은 완료하지 않은 사용자 생성
   */
  async createOrUpdatePendingKakaoUser(
    kakaoProfile: KakaoProfileResponse,
  ): Promise<User> {
    const kakaoUserId = String(kakaoProfile.id);
    const kakaoAccount = kakaoProfile.kakao_account;
    const kakaoProfileData = kakaoAccount?.profile;

    let user = await this.findByKakaoUserId(kakaoUserId);

    if (!user) {
      user = this.userRepository.create({
        kakaoUserId: kakaoUserId,

        email: kakaoAccount?.email ?? null,

        nickname: kakaoProfileData?.nickname ?? null,

        profileImageUrl: kakaoProfileData?.profile_image_url ?? null,

        registrationCompleted: false,
      });

      return this.userRepository.save(user);
    }

    // 가입 도중 나갔다가 다시 로그인한 경우
    user.email = kakaoAccount?.email ?? user.email;

    user.nickname = kakaoProfileData?.nickname ?? user.nickname;

    user.profileImageUrl =
      kakaoProfileData?.profile_image_url ?? user.profileImageUrl;

    return this.userRepository.save(user);
  }

  /**
   * 기존 회원 로그인 처리
   *
   * 우리 서비스의 Access Token과
   * Refresh Token을 만들어 쿠키에 저장
   */
  async setLoginCookies(response: Response, user: User): Promise<void> {
    if (!user.registrationCompleted) {
      throw new UnauthorizedException('회원가입이 완료되지 않은 사용자입니다.');
    }
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      type: 'access',
    };

    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m',
    });

    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        type: 'refresh',
      },
      {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: '14d',
      },
    );

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';

    response.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    response.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  /**
   * 가입 대기 사용자를 확인하기 위한 임시 토큰
   */
  async setSignupCookie(response: Response, user: User): Promise<void> {
    const signupToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        purpose: 'signup',
      },
      {
        secret: this.configService.getOrThrow<string>('JWT_SIGNUP_SECRET'),
        expiresIn: '30m',
      },
    );

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';

    response.cookie('signup_token', signupToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 30 * 60 * 1000,
    });
  }

  /**
   * 회원가입 완료
   */
  async completeSignup(
    signupToken: string | undefined,
    signupDto: SignupDto,
  ): Promise<User> {
    if (!signupToken) {
      throw new UnauthorizedException('카카오 로그인이 필요합니다.');
    }

    let payload: SignupTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<SignupTokenPayload>(
        signupToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_SIGNUP_SECRET'),
        },
      );
    } catch {
      throw new UnauthorizedException('회원가입 인증이 만료되었습니다.');
    }

    if (payload.purpose !== 'signup') {
      throw new UnauthorizedException('올바르지 않은 회원가입 토큰입니다.');
    }

    const user = await this.userRepository.findOneBy({
      id: payload.sub,
    });

    if (!user) {
      throw new NotFoundException('가입 대기 사용자를 찾을 수 없습니다.');
    }

    if (user.registrationCompleted) {
      throw new ConflictException('이미 가입된 회원입니다.');
    }

    user.nickname = signupDto.nickname;
    user.registrationCompleted = true;

    return this.userRepository.save(user);
  }

  async refreshLogin(refreshToken: string | undefined): Promise<User> {
    if (!refreshToken) {
      throw new UnauthorizedException('리프레시 토큰이 없습니다.');
    }

    let payload: RefreshTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        },
      );
    } catch {
      throw new UnauthorizedException(
        '리프레시 토큰이 만료되었거나 올바르지 않습니다.',
      );
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('올바르지 않은 리프레시 토큰입니다.');
    }

    const user = await this.userRepository.findOneBy({
      id: payload.sub,
    });

    if (!user || !user.registrationCompleted) {
      throw new UnauthorizedException('로그인할 수 없는 사용자입니다.');
    }

    return user;
  }
}
