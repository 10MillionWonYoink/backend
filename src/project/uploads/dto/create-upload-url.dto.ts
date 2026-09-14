import { IsIn, IsInt, Max, Min } from 'class-validator';
import { IMAGE_EXTENSION_BY_TYPE } from '../types/image-type';

export class CreateUploadUrlDto {
  @IsInt()
  @Min(1)
  roomId: number;

  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType: keyof typeof IMAGE_EXTENSION_BY_TYPE;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  fileSize: number;
}
