import { IsIn, IsInt, Max, Min } from 'class-validator';
import { IMAGE_EXTENSION_BY_TYPE } from '../types/image-type';
import { Type } from 'class-transformer';

export class CreateUploadUrlDto {
  @IsInt()
  @Min(1)
  roomId: number;

  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType: keyof typeof IMAGE_EXTENSION_BY_TYPE;

  @Type(() => Number)
  @IsInt({ message: '파일 크기가 올바르지 않습니다.' })
  @Min(1, { message: '빈 파일은 업로드할 수 없습니다.' })
  @Max(10 * 1024 * 1024, {
    message: '사진은 최대 10MB까지 업로드할 수 있습니다.',
  })
  fileSize: number;
}
