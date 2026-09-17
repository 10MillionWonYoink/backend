import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/security/jwt-auth-guard';
import { GetUser } from '../auth/security/get-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presigned-url')
  createUploadUrl(
    @Body()
    dto: CreateUploadUrlDto,
    @GetUser() user: User,
  ) {
    return this.uploadsService.createUploadUrl({
      roomId: dto.roomId,
      userId: user.id,
      contentType: dto.contentType,
      fileSize: dto.fileSize,
    });
  }
}
