import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    description: '사용자 이메일',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  @MaxLength(255)
  email: string;

  @ApiProperty({
    description: '비밀번호',
    example: 'password1234',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력해주세요.' })
  @MinLength(8, {
    message: '비밀번호는 8자 이상이어야 합니다.',
  })
  @MaxLength(64, {
    message: '비밀번호는 64자 이하여야 합니다.',
  })
  password: string;

  @ApiProperty({
    description: '사용자 이름',
    example: '장권영',
    minLength: 2,
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: '이름을 입력해주세요.' })
  @MinLength(2, {
    message: '이름은 2자 이상이어야 합니다.',
  })
  @MaxLength(50, {
    message: '이름은 50자 이하여야 합니다.',
  })
  name: string;
}
