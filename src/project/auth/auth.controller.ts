import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { GetUser } from './security/get-user.decorator';
import { JwtAuthGuard } from './security/jwt-auth-guard';
import { User } from '../users/entities/user.entity';

@Controller('auth')
export class AuthController {
  private readonly frontendUrl: string;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@GetUser() user: User) {
    return {
      authenticated: true,
      registrationCompleted: user.registrationCompleted,

      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        profileImageUrl: user.profileImageUrl,
      },
    };
  }

  @Get('kakao')
  kakao(@Res() response: ExpressResponse): void {
    const authorizationUrl = this.authService.createKakaoAuthorizationUrl();

    response.redirect(authorizationUrl);
  }

  @Get('kakao/callback')
  async kakaoCallback(
    @Query('code') code: string,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const kakaoToken = await this.authService.getKakaoToken(code);

    const kakaoProfile = await this.authService.getKakaoProfile(
      kakaoToken.access_token,
    );

    const user = await this.authService.findByKakaoUserId(
      String(kakaoProfile.id),
    );

    if (user?.registrationCompleted) {
      await this.authService.setLoginCookies(response, user);

      response.redirect(`${this.frontendUrl}/`);
      return;
    }

    const pendingUser =
      await this.authService.createOrUpdatePendingKakaoUser(kakaoProfile);

    await this.authService.setSignupCookie(response, pendingUser);

    response.redirect(`${this.frontendUrl}/signup`);
  }

  @Post('signup')
  async signup(
    @Req() request: ExpressRequest,
    @Body() signupDto: SignupDto,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const signupToken = request.cookies?.signup_token as string | undefined;

    const user = await this.authService.completeSignup(signupToken, signupDto);

    await this.authService.setLoginCookies(response, user);

    response.clearCookie('signup_token', {
      path: '/',
    });

    response.status(200).json({
      message: '회원가입이 완료되었습니다.',
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
      },
    });
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req()
    request: ExpressRequest,

    @Res({ passthrough: true })
    response: ExpressResponse,
  ) {
    const token: unknown = request.cookies?.refresh_token;

    const refreshToken = typeof token === 'string' ? token : undefined;

    const user = await this.authService.refreshLogin(refreshToken);

    // 새로운 Access·Refresh Token 발급
    await this.authService.setLoginCookies(response, user);

    return {
      message: '토큰이 재발급되었습니다.',
    };
  }
}
