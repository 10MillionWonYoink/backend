// Gemini 호출 자체(네트워크, 인증, 타임아웃, 설정 누락 등)가 실패했을 때
export class GeminiApiError extends Error {}

// Gemini 호출은 성공했지만 응답을 기대한 형식으로 파싱할 수 없을 때
export class GeminiResponseFormatError extends Error {}
