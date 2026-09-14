import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPartFromBase64,
  createUserContent,
  GoogleGenAI,
  Type,
  type GenerateContentResponse,
  type Schema,
} from '@google/genai';
import { GeminiApiError, GeminiResponseFormatError } from './gemini.errors';

export interface TopicResult {
  topic: string;
}

export interface PhotoEvaluationInput {
  imageUrl: string;
  topic: string;
}

export interface PhotoEvaluationResult {
  score: number;
  feedback: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 15_000;

const TOPIC_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    topic: {
      type: Type.STRING,
      description: '사진으로 표현할 짧고 명확한 포토 릴레이 게임 주제 한 문장',
    },
  },
  required: ['topic'],
};

const EVALUATION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: {
      type: Type.INTEGER,
      description: '0~100 사이의 정수 점수',
    },
    feedback: {
      type: Type.STRING,
      description: '한두 문장의 짧은 평가 코멘트',
    },
  },
  required: ['score', 'feedback'],
};

function isTopicPayload(value: unknown): value is { topic: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).topic === 'string' &&
    (value as Record<string, unknown>).topic !== ''
  );
}

function isEvaluationPayload(
  value: unknown,
): value is { score: number; feedback: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.score === 'number' &&
    Number.isFinite(record.score) &&
    typeof record.feedback === 'string'
  );
}

/**
 * Gemini API를 감싸는 저수준 클라이언트.
 *
 * - 게임/턴 도메인을 전혀 알지 못한다 (topic 문자열, 이미지 URL만 입출력).
 * - API 실패/응답 형식 오류를 각각 다른 에러 타입으로 던져 호출부가 구분해 처리할 수 있게 한다.
 * - 호출부(GamesService)가 실패를 흡수해 게임 진행에 영향이 없도록 하는 책임은 이 서비스가 아니라 호출부에 있다.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.model =
      this.configService.get<string>('GEMINI_MODEL') ?? DEFAULT_MODEL;

    const timeout = Number(this.configService.get<string>('GEMINI_TIMEOUT_MS'));

    this.timeoutMs =
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
  }

  async generateTopic(): Promise<TopicResult> {
    const client = this.getClient();

    const prompt = [
      '친구들과 함께하는 "포토 릴레이" 게임에서 사용할 사진 주제를 하나 만들어줘.',
      '조건:',
      '- 사진으로 표현할 수 있는 주제일 것',
      '- 한 문장으로 짧고 명확할 것',
      '- 특정 장소·사람·브랜드를 과도하게 요구하지 않을 것',
      '- 친구들과 사진 릴레이 게임에서 재미있게 사용할 수 있을 것',
      '반드시 지정된 JSON 형식으로만 응답해.',
    ].join('\n');

    let response: GenerateContentResponse;

    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: TOPIC_SCHEMA,
        },
      });
    } catch (error) {
      this.logger.warn(`Gemini Topic 생성 호출 실패: ${this.describe(error)}`);
      throw new GeminiApiError('Topic 생성 요청에 실패했습니다.');
    }

    const parsed = this.parseJson(response);

    if (!isTopicPayload(parsed)) {
      throw new GeminiResponseFormatError(
        'Topic 응답 형식이 올바르지 않습니다.',
      );
    }

    return { topic: parsed.topic.trim() };
  }

  async evaluatePhoto({
    imageUrl,
    topic,
  }: PhotoEvaluationInput): Promise<PhotoEvaluationResult> {
    const client = this.getClient();

    const imagePart = await this.fetchImagePart(imageUrl);

    const promptText = [
      '이 사진은 "포토 릴레이" 게임에서 아래 주제에 맞춰 참가자가 제출한 사진이야.',
      `주제: ${topic}`,
      '다음 기준으로 0~100 사이 점수를 매기고 한두 문장으로 피드백을 남겨줘:',
      '- 주제와 사진의 연관성',
      '- 사진이 주제를 얼마나 잘 표현했는지',
      '- 사진 릴레이 게임에서의 재미·적합성',
      '반드시 지정된 JSON 형식으로만 응답해.',
    ].join('\n');

    let response: GenerateContentResponse;

    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: createUserContent([promptText, imagePart]),
        config: {
          responseMimeType: 'application/json',
          responseSchema: EVALUATION_SCHEMA,
        },
      });
    } catch (error) {
      this.logger.warn(`Gemini 사진 평가 호출 실패: ${this.describe(error)}`);
      throw new GeminiApiError('사진 평가 요청에 실패했습니다.');
    }

    const parsed = this.parseJson(response);

    if (!isEvaluationPayload(parsed)) {
      throw new GeminiResponseFormatError(
        '평가 응답 형식이 올바르지 않습니다.',
      );
    }

    // AI가 범위를 벗어난 점수를 주더라도 0~100으로 방어적으로 보정한다.
    const score = Math.round(Math.min(100, Math.max(0, parsed.score)));

    return { score, feedback: parsed.feedback.trim() };
  }

  private getClient(): GoogleGenAI {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    if (!apiKey) {
      throw new GeminiApiError('GEMINI_API_KEY가 설정되지 않았습니다.');
    }

    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: this.timeoutMs,
      },
    });

    return this.client;
  }

  private async fetchImagePart(imageUrl: string) {
    let response: Response;

    try {
      response = await fetch(imageUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 이미지 URL(서명된 S3 URL 등)에는 민감한 토큰이 포함될 수 있으므로 로그에 남기지 않는다.
      this.logger.warn(`평가용 이미지 다운로드 실패: ${this.describe(error)}`);
      throw new GeminiApiError('이미지를 불러오지 못했습니다.');
    }

    if (!response.ok) {
      this.logger.warn(`평가용 이미지 응답 실패 (status=${response.status})`);
      throw new GeminiApiError('이미지를 불러오지 못했습니다.');
    }

    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    return createPartFromBase64(buffer.toString('base64'), mimeType);
  }

  private parseJson(response: GenerateContentResponse): unknown {
    const text = response.text;

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : '알 수 없는 오류';
  }
}
