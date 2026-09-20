import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import type { RealtimeSocket } from '../types/realtime-socket.type';

/**
 * NestJS의 기본 WS 예외 필터(BaseWsExceptionFilter)는 WsException이 아닌 예외를
 * 전부 "Internal server error"라는 고정 문구로 뭉뚱그려 클라이언트에 전달한다
 * (HttpException은 IntrinsicException을 상속하므로 로그도 남기지 않는다).
 *
 * 이 프로젝트의 서비스 레이어(GamesService/RoomsService 등)는 대부분
 * NotFoundException/ConflictException 같은 일반 HttpException을 던지므로,
 * 그 실제 메시지와 상태 코드를 그대로 클라이언트에 전달하도록 보정한다.
 * WsException이나 그 외 예기치 못한 오류는 기존 기본 동작(및 로깅)을 그대로 따른다.
 */
@Catch()
export class WsHttpExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      super.catch(exception, host);
      return;
    }

    const client = host.switchToWs().getClient<RealtimeSocket>();
    const response = exception.getResponse();

    const message =
      typeof response === 'string'
        ? response
        : this.extractMessage(response, exception.message);

    client.emit('exception', {
      status: 'error',
      statusCode: exception.getStatus(),
      message,
    });
  }

  private extractMessage(response: unknown, fallback: string): string {
    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      const message = (response as Record<string, unknown>).message;

      if (typeof message === 'string') {
        return message;
      }

      if (Array.isArray(message)) {
        return message.join(' ');
      }
    }

    return fallback;
  }
}
