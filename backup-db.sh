#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

CONTAINER_NAME="app-postgres"
BACKUP_DIR="/opt/app/backups"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

BACKUP_FILE="${BACKUP_DIR}/picyonik_${TIMESTAMP}.dump"
TEMP_FILE="${BACKUP_FILE}.tmp"

mkdir -p "$BACKUP_DIR"

# 실패하면 불완전한 임시 파일 삭제
trap 'rm -f "$TEMP_FILE"' EXIT

# PostgreSQL 컨테이너 실행 여부 확인
if ! docker inspect \
  --format '{{.State.Running}}' \
  "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
  echo "오류: ${CONTAINER_NAME} 컨테이너가 실행 중이 아닙니다."
  exit 1
fi

echo "DB 백업을 시작합니다."

# PostgreSQL 백업
docker exec "$CONTAINER_NAME" sh -c \
  'exec pg_dump \
    -U "$POSTGRES_USER" \
    -d "${POSTGRES_DB:-$POSTGRES_USER}" \
    -Fc' > "$TEMP_FILE"

# 빈 파일 검사
if [[ ! -s "$TEMP_FILE" ]]; then
  echo "오류: 백업 파일이 비어 있습니다."
  exit 1
fi

# 백업 파일 형식 검사
docker exec -i "$CONTAINER_NAME" \
  pg_restore -l < "$TEMP_FILE" > /dev/null

# 검사 완료 후 최종 파일명으로 변경
mv "$TEMP_FILE" "$BACKUP_FILE"
trap - EXIT

echo "백업 완료"
echo "파일: $BACKUP_FILE"
ls -lh "$BACKUP_FILE"