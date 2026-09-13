import { Injectable } from '@nestjs/common';

/**
 * GameTurn.imageKey(S3 객체 key)를 AI 평가가 실제로 내려받을 수 있는 URL로 변환한다.
 *
 * S3 업로드/버킷 구성은 별도 작업에서 진행 중이므로, 이 클래스는 "imageKey -> imageUrl"
 * 변환 지점만 분리해둔다. S3 연동이 끝나면 이 파일의 구현만 교체하면 된다.
 */
@Injectable()
export class ImageUrlResolver {
  resolve(imageKey: string): Promise<string> {
    // 이미 완전한 URL이 저장된 경우(테스트, 혹은 향후 서명된 URL을 그대로 저장하는 경우)는
    // 그대로 사용한다.
    if (/^https?:\/\//i.test(imageKey)) {
      return Promise.resolve(imageKey);
    }

    // TODO(S3 연동): 실제 버킷/CDN 기반 URL 생성 로직으로 교체.
    // 현재는 S3 업로드/저장 방식이 확정되지 않았으므로 임의로 URL을 만들어내지 않는다.
    return Promise.reject(
      new Error(
        'S3 이미지 URL 변환이 아직 연동되지 않았습니다 (imageKey -> imageUrl).',
      ),
    );
  }
}
