import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';

interface AuthenticatedRequest extends Request {
  user: {
    sub: number;
  };
}

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presigned-url')
  createUploadUrl(
    @Body()
    dto: CreateUploadUrlDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.uploadsService.createUploadUrl({
      roomId: dto.roomId,
      userId: request.user.sub,
      contentType: dto.contentType,
    });
  }
}
