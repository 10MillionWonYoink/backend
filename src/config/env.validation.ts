import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsIn(['dev', 'test', 'production'])
  NODE_ENV: string = 'dev';

  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  DB_HOST: string;

  @Transform(({ value }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(65535)
  DB_PORT: number = 5432;

  @IsString()
  DB_USERNAME: string;

  @IsString()
  DB_PASSWORD: string;

  @IsString()
  DB_DATABASE: string;

  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  DB_SSL: boolean = false;

  // Gemini API Key. 미설정 시 AI 기능(Topic 생성/사진 평가)만 비활성화되고
  // 나머지 애플리케이션(게임 진행 등)은 정상 동작해야 하므로 필수값으로 두지 않는다.
  @IsOptional()
  @IsString()
  GEMINI_API_KEY?: string;

  // 사용할 Gemini 모델. 미설정 시 GeminiService의 기본값을 사용한다.
  @IsOptional()
  @IsString()
  GEMINI_MODEL?: string;

  // S3 설정
  @IsString()
  @IsNotEmpty()
  AWS_REGION: string;

  @IsString()
  @IsNotEmpty()
  AWS_S3_BUCKET: string;

  @ValidateIf(
    (config: EnvironmentVariables) =>
      config.AWS_ACCESS_KEY_ID !== undefined ||
      config.AWS_SECRET_ACCESS_KEY !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  AWS_ACCESS_KEY_ID?: string;

  @ValidateIf(
    (config: EnvironmentVariables) =>
      config.AWS_ACCESS_KEY_ID !== undefined ||
      config.AWS_SECRET_ACCESS_KEY !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY?: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  return validatedConfig;
}
