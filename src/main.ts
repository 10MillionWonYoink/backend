import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('App API')
    .setDescription('App 백엔드 API 문서')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, swaggerDocument);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  app.enableCors({
    origin: [
      'http://localhost:5173',
      'http://10millionwonyoink-frontend-dev-586008061073-ap-northeast-2-an.s3-website.ap-northeast-2.amazonaws.com',
    ],
    credentials: true,
  });

  await app.listen(port);

  console.log(`Server: http://localhost:${port}`);
  console.log(`Swagger: http://localhost:${port}/docs`);
}

void bootstrap();
