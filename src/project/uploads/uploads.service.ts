import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { IMAGE_EXTENSION_BY_TYPE } from './types/image-type';

interface CreateUploadUrlParams {
  roomId: number;
  userId: number;
  contentType: keyof typeof IMAGE_EXTENSION_BY_TYPE;
  fileSize: number;
}

@Injectable()
export class UploadsService {
  private readonly s3Client: S3Client;

  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.getOrThrow<string>('AWS_REGION');

    this.bucketName = this.configService.getOrThrow<string>('AWS_S3_BUCKET');

    this.s3Client = new S3Client({
      region,
    });
  }

  async verifyUploadedImage({
    roomId,
    userId,
    objectKey,
  }: {
    roomId: number;
    userId: number;
    objectKey: string;
  }) {
    const expectedPrefix = `rooms/${roomId}/users/${userId}/`;

    console.log({
      roomId,
      userId,
      objectKey: JSON.stringify(objectKey),
      expectedPrefix: JSON.stringify(expectedPrefix),
      matched: objectKey.startsWith(expectedPrefix),
    });

    if (!objectKey.startsWith(expectedPrefix)) {
      throw new BadRequestException('올바르지 않은 이미지 경로입니다.');
    }

    let metadata: HeadObjectCommandOutput;

    try {
      metadata = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey,
        }),
      );
    } catch {
      throw new BadRequestException('S3에 업로드된 이미지를 찾을 수 없습니다.');
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (!metadata.ContentType || !allowedTypes.includes(metadata.ContentType)) {
      throw new BadRequestException('지원하지 않는 이미지 형식입니다.');
    }

    const maxSize = 10 * 1024 * 1024;

    if (!metadata.ContentLength || metadata.ContentLength > maxSize) {
      throw new BadRequestException('이미지 용량은 10MB 이하여야 합니다.');
    }
  }

  async createImageReadUrl(objectKey: string) {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      }),
      {
        expiresIn: 60 * 10,
      },
    );
  }

  async createUploadUrl({
    roomId,
    userId,
    contentType,
    fileSize,
  }: CreateUploadUrlParams) {
    const maxSize = 10 * 1024 * 1024;

    if (!Number.isInteger(fileSize) || fileSize < 1) {
      throw new BadRequestException('올바르지 않은 파일 크기입니다.');
    }

    if (fileSize > maxSize) {
      throw new BadRequestException('이미지 용량은 10MB 이하여야 합니다.');
    }

    const extension = IMAGE_EXTENSION_BY_TYPE[contentType];

    if (!extension) {
      throw new BadRequestException('지원하지 않는 이미지 형식입니다.');
    }

    const objectKey = [
      'rooms',
      roomId,
      'users',
      userId,
      `${randomUUID()}.${extension}`,
    ].join('/');

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 60,
    });

    return {
      objectKey,
      uploadUrl,
      expiresIn: 60,
    };
  }
}
