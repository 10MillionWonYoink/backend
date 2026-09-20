import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
  private readonly keyPrefix: string;
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.getOrThrow<string>('AWS_REGION');

    this.bucketName = this.configService.getOrThrow<string>('AWS_S3_BUCKET');

    this.keyPrefix =
      this.configService
        .get<string>('S3_KEY_PREFIX')
        ?.trim()
        .replace(/^\/+|\/+$/g, '') ?? '';

    this.s3Client = new S3Client({
      region,
    });
  }

  private createUserDirectory(roomId: number, userId: number): string {
    const segments = ['rooms', String(roomId), 'users', String(userId)];

    if (this.keyPrefix) {
      segments.unshift(this.keyPrefix);
    }

    return `${segments.join('/')}/`;
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
    const expectedPrefix = this.createUserDirectory(roomId, userId);

    if (!objectKey.startsWith(expectedPrefix)) {
      this.logger.warn(
        JSON.stringify({
          event: 'uploaded_image_verification_failed',
          reason: 'invalid_object_key_prefix',
          roomId,
          userId,
          objectKey,
          expectedPrefix,
        }),
      );

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
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'uploaded_image_verification_failed',
          reason: 's3_head_object_failed',
          roomId,
          userId,
          objectKey,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );

      throw new BadRequestException('S3에 업로드된 이미지를 찾을 수 없습니다.');
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (!metadata.ContentType || !allowedTypes.includes(metadata.ContentType)) {
      this.logger.warn(
        JSON.stringify({
          event: 'uploaded_image_verification_failed',
          reason: 'unsupported_content_type',
          roomId,
          userId,
          objectKey,
          contentType: metadata.ContentType ?? null,
        }),
      );

      throw new BadRequestException('지원하지 않는 이미지 형식입니다.');
    }

    const maxSize = 10 * 1024 * 1024;

    if (!metadata.ContentLength || metadata.ContentLength > maxSize) {
      this.logger.warn(
        JSON.stringify({
          event: 'uploaded_image_verification_failed',
          reason: 'invalid_content_length',
          roomId,
          userId,
          objectKey,
          contentLength: metadata.ContentLength ?? null,
          maxSize,
        }),
      );

      throw new BadRequestException('이미지 용량은 10MB 이하여야 합니다.');
    }
  }

  async createImageReadUrl(objectKey: string) {
    try {
      return await getSignedUrl(
        this.s3Client,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey,
        }),
        {
          expiresIn: 60 * 10,
        },
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'image_read_url_creation_failed',
          objectKey,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }

  async createUploadUrl({
    roomId,
    userId,
    contentType,
    fileSize,
  }: CreateUploadUrlParams) {
    const maxSize = 10 * 1024 * 1024;

    if (!Number.isInteger(fileSize) || fileSize < 1) {
      this.logger.warn(
        JSON.stringify({
          event: 'upload_url_creation_failed',
          reason: 'invalid_file_size',
          roomId,
          userId,
          contentType,
          fileSize,
        }),
      );

      throw new BadRequestException('올바르지 않은 파일 크기입니다.');
    }

    if (fileSize > maxSize) {
      this.logger.warn(
        JSON.stringify({
          event: 'upload_url_creation_failed',
          reason: 'file_size_exceeded',
          roomId,
          userId,
          contentType,
          fileSize,
          maxSize,
        }),
      );

      throw new BadRequestException('이미지 용량은 10MB 이하여야 합니다.');
    }

    const extension = IMAGE_EXTENSION_BY_TYPE[contentType];

    if (!extension) {
      this.logger.warn(
        JSON.stringify({
          event: 'upload_url_creation_failed',
          reason: 'unsupported_content_type',
          roomId,
          userId,
          contentType,
          fileSize,
        }),
      );

      throw new BadRequestException('지원하지 않는 이미지 형식입니다.');
    }

    const directory = this.createUserDirectory(roomId, userId);
    const objectKey = `${directory}${randomUUID()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: contentType,
    });

    try {
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 60,
      });

      return {
        objectKey,
        uploadUrl,
        expiresIn: 60,
      };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'upload_url_creation_failed',
          reason: 'presigned_url_creation_failed',
          roomId,
          userId,
          objectKey,
          contentType,
          fileSize,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }
}
