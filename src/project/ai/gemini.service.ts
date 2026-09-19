import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPartFromBase64,
  createUserContent,
  GoogleGenAI,
  Type,
  type GenerateContentResponse,
  type Part,
  type Schema,
} from '@google/genai';
import { GeminiApiError, GeminiResponseFormatError } from './gemini.errors';

export interface TopicBatchResult {
  topics: string[];
}

export interface PhotoEvaluationRequestItem {
  turnIndex: number;
  imageUrl: string;
  topic: string;
}

export interface PhotoEvaluationResultItem {
  turnIndex: number;
  relevance: number;
  expression: number;
  creativity: number;
  feedback: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 15_000;

function topicBatchSchema(count: number): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      topics: {
        type: Type.ARRAY,
        minItems: String(count),
        maxItems: String(count),
        items: {
          type: Type.STRING,
          description:
            '사진 한 장으로 표현할 수 있는 짧고 명확한 포토 릴레이 주제 한 문장',
        },
      },
    },
    required: ['topics'],
  };
}

const EVALUATION_BATCH_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    evaluations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          turnIndex: {
            type: Type.INTEGER,
            description:
              '평가 대상 사진에 매겨진 번호 (프롬프트에서 지정한 값 그대로)',
          },
          relevance: {
            type: Type.INTEGER,
            description: '주제 적합성 점수 (0~50)',
          },
          expression: {
            type: Type.INTEGER,
            description: '주제 표현력 점수 (0~30)',
          },
          creativity: {
            type: Type.INTEGER,
            description: '창의성/재미 점수 (0~20)',
          },
          feedback: {
            type: Type.STRING,
            description: '한두 문장의 짧은 평가 코멘트',
          },
        },
        required: [
          'turnIndex',
          'relevance',
          'expression',
          'creativity',
          'feedback',
        ],
      },
    },
  },
  required: ['evaluations'],
};

function isTopicBatchPayload(value: unknown): value is { topics: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).topics)
  );
}

function isEvaluationBatchPayload(
  value: unknown,
): value is { evaluations: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).evaluations)
  );
}

function parseEvaluationItem(value: unknown): PhotoEvaluationResultItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.turnIndex !== 'number' ||
    typeof record.relevance !== 'number' ||
    typeof record.expression !== 'number' ||
    typeof record.creativity !== 'number' ||
    typeof record.feedback !== 'string'
  ) {
    return null;
  }

  return {
    turnIndex: record.turnIndex,
    // AI가 항목별 범위를 벗어난 값을 주더라도 방어적으로 보정한다.
    relevance: clamp(record.relevance, 0, 50),
    expression: clamp(record.expression, 0, 30),
    creativity: clamp(record.creativity, 0, 20),
    feedback: record.feedback.trim(),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * Gemini API를 감싸는 저수준 클라이언트.
 *
 * - 게임/턴 도메인을 전혀 알지 못한다 (topic 문자열, 이미지 URL만 입출력).
 * - 게임당 Gemini 호출 횟수를 최소화하기 위해 Topic/평가 모두 배치(batch) 단위로만 호출한다.
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

  // 게임 한 판에서 필요한 Topic을 한 번의 호출로 모두 생성한다 (턴마다 호출하지 않는다).
  async generateTopics(count: number): Promise<TopicBatchResult> {
    const client = this.getClient();

    const prompt = [
      `친구들과 함께하는 "포토 릴레이" 게임에서 사용할, 서로 다른 사진 주제 ${count}개를 만들어줘.`,
      '각 주제는 다음 조건을 모두 만족해야 해:',
      '- 사진 한 장으로 표현할 수 있을 것',
      '- 짧고 명확할 것',
      '- 일상적인 공간에서 수행 가능할 것',
      '- 특정 인물/장소/브랜드를 강제하지 않을 것',
      '- 위험하거나 부적절한 행동을 요구하지 않을 것',
      '- 서로 의미가 겹치지 않을 것 (모두 달라야 함)',
      '- 포토 릴레이 게임에서 재미있게 표현할 수 있을 것',
      '- 너무 추상적이거나 사진으로 판단하기 어렵지 않을 것',
      `반드시 서로 다른 주제 ${count}개를 지정된 JSON 형식으로만 응답해.`,
    ].join('\n');

    let response: GenerateContentResponse;

    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: topicBatchSchema(count),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Gemini Topic 배치 생성 호출 실패: ${this.describe(error)}`,
      );
      throw new GeminiApiError('Topic 생성 요청에 실패했습니다.');
    }

    const parsed = this.parseJson(response);

    if (!isTopicBatchPayload(parsed)) {
      throw new GeminiResponseFormatError(
        'Topic 응답 형식이 올바르지 않습니다.',
      );
    }

    const topics = Array.from(
      new Set(
        parsed.topics
          .filter((topic): topic is string => typeof topic === 'string')
          .map((topic) => topic.trim())
          .filter((topic) => topic.length > 0),
      ),
    );

    if (topics.length === 0) {
      throw new GeminiResponseFormatError(
        'Topic 응답 형식이 올바르지 않습니다.',
      );
    }

    // 게임당 호출 횟수 추적용 (요청한 수량 대비 실제 생성된 수량을 함께 남긴다).
    this.logger.log(
      `Gemini Topic 배치 생성 호출 1회 완료 (요청 ${count}개 / 생성 ${topics.length}개)`,
    );

    return { topics };
  }

  // 제출된 사진 여러 장을 한 번의 호출로 평가한다 (사진마다 호출하지 않는다).
  // 호출 크기(이미지 개수) 제한에 대비해 상위 호출부에서 적절한 크기로 나눠 호출한다.
  async evaluatePhotosBatch(
    items: PhotoEvaluationRequestItem[],
  ): Promise<PhotoEvaluationResultItem[]> {
    const client = this.getClient();

    const imageParts = await Promise.all(
      items.map((item) => this.fetchImagePart(item.imageUrl)),
    );

    const parts: (string | Part)[] = [
      [
        '아래는 "포토 릴레이" 게임에서 참가자들이 각자의 주제에 맞춰 제출한 사진들이야.',
        '사진마다 매겨진 번호(turnIndex)와 주제가 함께 주어진다.',
        '각 사진을 다음 기준으로 평가해줘 (모든 참가자에게 동일한 기준을 적용할 것):',
        '- 주제 적합성 (relevance, 0~50점): 사진이 주제와 얼마나 직접적으로 관련되어 있는지',
        '- 주제 표현력 (expression, 0~30점): 사진만 보고 주제를 얼마나 명확히 알 수 있는지',
        '- 창의성/재미 (creativity, 0~20점): 단순한 표현보다 재미있고 독창적으로 표현했는지',
        '사진에 실제로 보이지 않는 정보는 추측해서 점수를 올리거나 내리지 마.',
        '각 사진에 대해 turnIndex, relevance, expression, creativity, feedback(한두 문장)을 반환해.',
        '반드시 지정된 JSON 형식으로만, 아래 사진 개수만큼 응답해.',
      ].join('\n'),
    ];

    items.forEach((item, index) => {
      parts.push(
        `--- 사진 turnIndex=${item.turnIndex} / 주제: ${item.topic} ---`,
      );
      parts.push(imageParts[index]);
    });

    let response: GenerateContentResponse;

    try {
      response = await client.models.generateContent({
        model: this.model,
        contents: createUserContent(parts),
        config: {
          responseMimeType: 'application/json',
          responseSchema: EVALUATION_BATCH_SCHEMA,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Gemini 사진 평가 배치 호출 실패: ${this.describe(error)}`,
      );
      throw new GeminiApiError('사진 평가 요청에 실패했습니다.');
    }

    const parsed = this.parseJson(response);

    if (!isEvaluationBatchPayload(parsed)) {
      throw new GeminiResponseFormatError(
        '평가 응답 형식이 올바르지 않습니다.',
      );
    }

    const results = parsed.evaluations
      .map((entry) => parseEvaluationItem(entry))
      .filter((entry): entry is PhotoEvaluationResultItem => entry !== null);

    if (results.length === 0) {
      throw new GeminiResponseFormatError(
        '평가 응답 형식이 올바르지 않습니다.',
      );
    }

    // 게임당 호출 횟수 추적용 (청크 하나당 1회 호출됨을 확인하기 위함).
    this.logger.log(
      `Gemini 사진 평가 배치 호출 1회 완료 (요청 ${items.length}장 / 응답 ${results.length}건)`,
    );

    return results;
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
