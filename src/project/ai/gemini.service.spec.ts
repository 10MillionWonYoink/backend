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

  describe('generateTopics (배치 생성 - 게임당 1회 호출)', () => {
    it('정상 JSON 응답을 받으면 topics 배열을 반환한다', async () => {
      mockTextResponse({ topics: ['주제1', '주제2', '주제3'] });

      await expect(service.generateTopics(3)).resolves.toEqual({
        topics: ['주제1', '주제2', '주제3'],
      });
      expect(generateContentMock).toHaveBeenCalledTimes(1);
    });

    it('중복/빈 문자열은 제거하고 반환한다', async () => {
      mockTextResponse({ topics: ['주제1', '주제1', '', '  주제2  '] });

      const result = await service.generateTopics(4);

      expect(result.topics).toEqual(['주제1', '주제2']);
    });

    it('API 키가 없으면 GeminiApiError를 던진다', async () => {
      delete configValues.GEMINI_API_KEY;

      await expect(service.generateTopics(3)).rejects.toThrow(GeminiApiError);
      expect(generateContentMock).not.toHaveBeenCalled();
    });

    it('API 호출 자체가 실패하면 GeminiApiError를 던진다', async () => {
      generateContentMock.mockRejectedValue(new Error('network down'));

      await expect(service.generateTopics(3)).rejects.toThrow(GeminiApiError);
    });

    it('topics 필드가 없는 응답은 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ message: 'oops' });

      await expect(service.generateTopics(3)).rejects.toThrow(
        GeminiResponseFormatError,
      );
    });

    it('topics가 빈 배열이면 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ topics: [] });

      await expect(service.generateTopics(3)).rejects.toThrow(
        GeminiResponseFormatError,
      );
    });

    it('JSON으로 파싱할 수 없는 응답은 GeminiResponseFormatError를 던진다', async () => {
      generateContentMock.mockResolvedValue({ text: 'not-json' });

      await expect(service.generateTopics(3)).rejects.toThrow(
        GeminiResponseFormatError,
      );
    });
  });

  describe('evaluatePhotosBatch (배치 평가 - 청크당 1회 호출)', () => {
    it('정상 JSON 응답을 받으면 turnIndex별 평가 결과 배열을 반환한다', async () => {
      mockTextResponse({
        evaluations: [
          {
            turnIndex: 1,
            relevance: 42,
            expression: 25,
            creativity: 16,
            feedback: '좋아요',
          },
          {
            turnIndex: 2,
            relevance: 30,
            expression: 20,
            creativity: 10,
            feedback: '괜찮아요',
          },
        ],
      });

      const result = await service.evaluatePhotosBatch([
        { turnIndex: 1, imageUrl: 'https://example.com/1.jpg', topic: '주제1' },
        { turnIndex: 2, imageUrl: 'https://example.com/2.jpg', topic: '주제2' },
      ]);

      expect(result).toEqual([
        {
          turnIndex: 1,
          relevance: 42,
          expression: 25,
          creativity: 16,
          feedback: '좋아요',
        },
        {
          turnIndex: 2,
          relevance: 30,
          expression: 20,
          creativity: 10,
          feedback: '괜찮아요',
        },
      ]);
      // 사진 2장이어도 Gemini 호출은 1회
      expect(generateContentMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        { relevance: 999, expression: -5, creativity: 100 },
        { relevance: 50, expression: 0, creativity: 20 },
      ],
    ])(
      '항목별 점수가 범위를 벗어나면 방어적으로 보정한다',
      async (raw, expected) => {
        mockTextResponse({
          evaluations: [{ turnIndex: 1, ...raw, feedback: '피드백' }],
        });

        const [result] = await service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/1.jpg',
            topic: '주제',
          },
        ]);

        expect(result.relevance).toBe(expected.relevance);
        expect(result.expression).toBe(expected.expression);
        expect(result.creativity).toBe(expected.creativity);
      },
    );

    it('API 호출 자체가 실패하면 GeminiApiError를 던진다', async () => {
      generateContentMock.mockRejectedValue(new Error('network down'));

      await expect(
        service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/1.jpg',
            topic: '주제',
          },
        ]),
      ).rejects.toThrow(GeminiApiError);
    });

    it('이미지 다운로드에 실패하면 GeminiApiError를 던진다', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('dns error'));

      await expect(
        service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/broken.jpg',
            topic: '주제',
          },
        ]),
      ).rejects.toThrow(GeminiApiError);
      expect(generateContentMock).not.toHaveBeenCalled();
    });

    it('이미지 응답이 실패(4xx/5xx)이면 GeminiApiError를 던진다', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

      await expect(
        service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/forbidden.jpg',
            topic: '주제',
          },
        ]),
      ).rejects.toThrow(GeminiApiError);
    });

    it('evaluations 필드가 없는 응답은 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ message: 'oops' });

      await expect(
        service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/1.jpg',
            topic: '주제',
          },
        ]),
      ).rejects.toThrow(GeminiResponseFormatError);
    });

    it('형식이 맞지 않는 항목은 걸러내고, 유효한 항목만 반환한다', async () => {
      mockTextResponse({
        evaluations: [
          {
            turnIndex: 1,
            relevance: 40,
            expression: 20,
            creativity: 10,
            feedback: '좋아요',
          },
          {
            turnIndex: 2,
            relevance: 'not-a-number',
            expression: 20,
            creativity: 10,
            feedback: '오류',
          },
        ],
      });

      const result = await service.evaluatePhotosBatch([
        { turnIndex: 1, imageUrl: 'https://example.com/1.jpg', topic: '주제1' },
        { turnIndex: 2, imageUrl: 'https://example.com/2.jpg', topic: '주제2' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].turnIndex).toBe(1);
    });

    it('모든 항목이 형식에 맞지 않으면 GeminiResponseFormatError를 던진다', async () => {
      mockTextResponse({ evaluations: [{ turnIndex: 1 }] });

      await expect(
        service.evaluatePhotosBatch([
          {
            turnIndex: 1,
            imageUrl: 'https://example.com/1.jpg',
            topic: '주제',
          },
        ]),
      ).rejects.toThrow(GeminiResponseFormatError);
    });
  });
});
