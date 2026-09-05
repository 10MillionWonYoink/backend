#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:?배포할 서비스 이름이 필요합니다.}"

AWS_REGION="ap-northeast-2"
REGISTRY="586008061073.dkr.ecr.ap-northeast-2.amazonaws.com"

PARAMETER_NAME="/backend/server/compose-env"
COMPOSE_FILE="/opt/app/docker-compose-server.yml"
ENV_FILE="/opt/app/.env"

# 생성되는 파일을 소유자만 읽을 수 있도록 설정
umask 077

# Parameter Store에서 환경변수 다운로드
TEMP_ENV=$(mktemp /opt/app/.env.XXXXXX)

cleanup() {
  rm -f "${TEMP_ENV}"
}

trap cleanup EXIT

aws ssm get-parameter \
  --region "${AWS_REGION}" \
  --name "${PARAMETER_NAME}" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text > "${TEMP_ENV}"

# 빈 파일 생성 방지
if [ ! -s "${TEMP_ENV}" ]; then
  echo "Parameter Store에서 환경변수를 가져오지 못했습니다."
  exit 1
fi

# 기존 .env를 새로운 파일로 안전하게 교체
mv "${TEMP_ENV}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
trap - EXIT

# Compose 설정 검증
docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  config --quiet

# ECR 로그인
aws ecr get-login-password \
  --region "${AWS_REGION}" |
docker login \
  --username AWS \
  --password-stdin "${REGISTRY}"

# 최신 이미지 다운로드
docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  pull "${SERVICE}"

# 최신 이미지로 마이그레이션 실행
docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  run --rm "${SERVICE}" \
  npm run migration:run:prod

# 마이그레이션 성공 후 컨테이너 교체
docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  up -d --no-deps "${SERVICE}"

docker image prune -f

docker compose \
  --env-file "${ENV_FILE}" \
  -f "${COMPOSE_FILE}" \
  ps