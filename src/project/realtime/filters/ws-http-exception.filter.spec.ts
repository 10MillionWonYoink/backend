import { ArgumentsHost } from '@nestjs/common';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsHttpExceptionFilter } from './ws-http-exception.filter';

function createHost(client: { emit: jest.Mock }): ArgumentsHost {
  return {
    switchToWs: () => ({
      getClient: () => client,
      getData: () => ({ gameId: 1 }),
      getPattern: () => 'game:turn:submit',
    }),
  } as unknown as ArgumentsHost;
}

describe('WsHttpExceptionFilter', () => {
  let filter: WsHttpExceptionFilter;
  let client: { emit: jest.Mock };

  beforeEach(() => {
    filter = new WsHttpExceptionFilter();
    client = { emit: jest.fn() };
  });

  it('HttpException의 실제 메시지와 상태 코드를 그대로 전달한다', () => {
    const exception = new ConflictException('사진 제출 시간이 만료되었습니다.');

    filter.catch(exception, createHost(client));

    expect(client.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      statusCode: 409,
      message: '사진 제출 시간이 만료되었습니다.',
    });
  });

  it('message가 배열(class-validator 검증 오류)이면 이어붙여 전달한다', () => {
    const exception = new BadRequestException([
      'a is required',
      'b is required',
    ]);

    filter.catch(exception, createHost(client));

    expect(client.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      statusCode: 400,
      message: 'a is required b is required',
    });
  });

  it('HttpException이 아닌 예외는 Nest 기본 동작(일반 오류 메시지)으로 위임한다', () => {
    filter.catch(new Error('unexpected'), createHost(client));

    const [event, payload] = client.emit.mock.calls[0] as [
      string,
      { status: string; message: string },
    ];

    expect(event).toBe('exception');
    expect(payload.status).toBe('error');
    expect(payload.message).toBe('Internal server error');
  });

  it('WsException은 Nest 기본 동작(getError 메시지 그대로)으로 위임한다', () => {
    filter.catch(
      new WsException('해당 채널에 참여하고 있지 않습니다.'),
      createHost(client),
    );

    expect(client.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      message: '해당 채널에 참여하고 있지 않습니다.',
      cause: { pattern: 'game:turn:submit', data: { gameId: 1 } },
    });
  });
});
