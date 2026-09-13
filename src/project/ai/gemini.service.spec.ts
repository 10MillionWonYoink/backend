import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GeminiService } from './gemini.service';
import { GeminiApiError, GeminiResponseFormatError } from './gemini.errors';

const generateContentMock = jest.fn();

jest.mock('@google/genai', () => {
  const actual: object = jest.requireActual('@google/genai');

  return {
    ...actual,
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: { generateContent: generateContentMock },
    })),
  };
});

function mockTextResponse(payload: unknown) {
  generateContentMock.mockResolvedValue({ text: JSON.stringify(payload) });
}

describe('GeminiService', () => {
  let service: GeminiService;
  const configValues: Record<string, string> = {
    GEMINI_API_KEY: 'test-api-key',
  };
  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues.GEMINI_API_KEY = 'test-api-key';
    delete configValues.GEMINI_MODEL;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<GeminiService>(GeminiService);
  });

  describe('generateTopic', () => {
    it('정상 JSON 응답을 받으면 topic을 반환한다', async () => {
      mockTextResponse({ topic: '오늘 가장 신나는 순간을 찍어보세요!' });

      await expect(service.generateTopic()).resolves.toEqual({
        topic: '오늘 가장 신나는 순간을 찍어보세요!',
      });
    });

    it('API 키가 없으면 GeminiApiError를 던진다', async () => {
      delete configValues.GEMINI_API_KEY;

      await expect(service.generateTopic()).rejects.toThrow(GeminiApiError);
      expect(generateContentMock).not.toHaveBeenCalled();
    });

    it('API 호출 자체가 실패하면 GeminiApiError를 던진다', async () => {
      generateContentMock.mockRejectedValue(new Error('network down'));

      await expect(service.generateTopic()).rejects.toThrow(GeminiApiError);
    });

    it('topic 필드가 없는 응답은 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ message: 'oops' });

      await expect(service.generateTopic()).rejects.toThrow(
        GeminiResponseFormatError,
      );
    });

    it('JSON으로 파싱할 수 없는 응답은 GeminiResponseFormatError를 던진다', async () => {
      generateContentMock.mockResolvedValue({ text: 'not-json' });

      await expect(service.generateTopic()).rejects.toThrow(
        GeminiResponseFormatError,
      );
    });
  });

  describe('evaluatePhoto', () => {
    it('정상 JSON 응답을 받으면 score/feedback을 반환한다', async () => {
      mockTextResponse({ score: 87, feedback: '주제와 잘 어울려요.' });

      await expect(
        service.evaluatePhoto({
          imageUrl: 'https://example.com/photo.jpg',
          topic: '오늘의 하늘',
        }),
      ).resolves.toEqual({ score: 87, feedback: '주제와 잘 어울려요.' });
    });

    it.each([
      [150, 100],
      [-20, 0],
      [55.6, 56],
    ])('점수 %d은(는) %d로 보정된다', async (rawScore, expectedScore) => {
      mockTextResponse({ score: rawScore, feedback: '피드백' });

      const result = await service.evaluatePhoto({
        imageUrl: 'https://example.com/photo.jpg',
        topic: '주제',
      });

      expect(result.score).toBe(expectedScore);
    });

    it('이미지 다운로드에 실패하면 GeminiApiError를 던진다', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('dns error'));

      await expect(
        service.evaluatePhoto({
          imageUrl: 'https://example.com/broken.jpg',
          topic: '주제',
        }),
      ).rejects.toThrow(GeminiApiError);
      expect(generateContentMock).not.toHaveBeenCalled();
    });

    it('이미지 응답이 실패(4xx/5xx)이면 GeminiApiError를 던진다', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });

      await expect(
        service.evaluatePhoto({
          imageUrl: 'https://example.com/forbidden.jpg',
          topic: '주제',
        }),
      ).rejects.toThrow(GeminiApiError);
    });

    it('score/feedback 형식이 아니면 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ score: 'not-a-number', feedback: '피드백' });

      await expect(
        service.evaluatePhoto({
          imageUrl: 'https://example.com/photo.jpg',
          topic: '주제',
        }),
      ).rejects.toThrow(GeminiResponseFormatError);
    });
  });
});
