import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
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
import { Controller, Get, Param, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  findAll() {
    return this.authService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.authService.findOne(+id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.authService.remove(+id);
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
