import {
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({
    description: '사용자 이메일',
    example: 'user@example.com',
    maxLength: 255,
  })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  @IsNotEmpty({ message: '이메일을 입력해주세요.' })
  @MaxLength(255, {
    message: '이메일은 255자 이하여야 합니다.',
  })
  email: string;

  @ApiProperty({
    description: '비밀번호',
    example: 'password1234',
    minLength: 8,
    maxLength: 64,
  })
  @IsString({ message: '비밀번호는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '비밀번호를 입력해주세요.' })
  @MinLength(8, {
    message: '비밀번호는 8자 이상이어야 합니다.',
  })
  @MaxLength(64, {
    message: '비밀번호는 64자 이하여야 합니다.',
  })
  password: string;

  @ApiProperty({
    description: '사용자 닉네임',
    example: '장권영',
    minLength: 2,
    maxLength: 30,
  })
  @IsString({ message: '닉네임은 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '닉네임을 입력해주세요.' })
  @MinLength(2, {
    message: '닉네임은 2자 이상이어야 합니다.',
  })
  @MaxLength(30, {
    message: '닉네임은 30자 이하여야 합니다.',
  })
  nickname: string;

  @ApiPropertyOptional({
    description: '생년월일',
    example: '1993-01-01',
    format: 'date',
    nullable: true,
  })
  @IsOptional()
  @IsDateString(
    {},
    {
      message: '생년월일은 YYYY-MM-DD 형식이어야 합니다.',
    },
  )
  birthDate?: string;

  @ApiPropertyOptional({
    description: '프로필 이미지 URL',
    example: 'https://example.com/images/profile.jpg',
    maxLength: 500,
    nullable: true,
  })
  @IsOptional()
  @IsUrl(
    {},
    {
      message: '올바른 프로필 이미지 URL 형식이 아닙니다.',
    },
  )
  @MaxLength(500, {
    message: '프로필 이미지 URL은 500자 이하여야 합니다.',
  })
  profileImageUrl?: string;
}
