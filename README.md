## 데이터베이스 올리기

자신의 개발 환경 (로컬 환경) 에서 데이터베이스를 실행을 할 때, 먼저 Docker를 실행 합니다.

### DB UP

```bash
npm run db:up
```

실행 후 해당 명령어를 실행하시면 됩니다. (해당 명령어는 docker compose를 실행해서 하는 방법입니다.)

### DB DOWN

데이터베이스를 캔슬을 할 때

```bash
npm run db:down
```

상기의 명령어를 실행합니다.

## 데이터베이스 마이그레이션 생성

Entity 변경사항과 현재 데이터베이스 구조를 비교하여 TypeORM 마이그레이션 파일을 생성합니다.

### 명령어 형식

```bash
npm run migration:generate -- ./src/database/migrations/<MigrationName>
```

`MigrationName`에는 변경 내용을 알아보기 쉬운 이름으로 작성합니다.

### 최초 Users 테이블 생성 예제

```bash
npm run migration:generate -- ./src/database/migrations/CreateUsers
```

명령을 실행하면 `User` Entity와 현재 데이터베이스를 비교하여 다음과 같은 파일이 자동 생성됩니다. 주의) 상용 서버에서는 해당 명령어 쓰지 않기

```text
src/database/migrations/1787900000000-CreateUsers.ts
```

`CreateUsers`는 테이블을 직접 생성하라는 명령이 아니라, 자동 생성되는 마이그레이션 파일에 붙이는 이름입니다. 실제 SQL은 TypeORM이 Entity와 데이터베이스의 차이를 비교하여 생성합니다.

### Entity 변경 예제

User Entity에 전화번호 컬럼을 추가했다면:

```typescript
@Column({ nullable: true })
phone
:
string | null;
```

다음과 같이 마이그레이션을 생성합니다.

```bash
npm run migration:generate -- ./src/database/migrations/AddPhoneToUsers
```

### 마이그레이션 적용

생성된 파일의 SQL을 확인한 후 데이터베이스에 적용합니다.

```bash
npm run migration:run
```

### 적용 상태 확인

```bash
npm run migration:show
```

표시되는 상태의 의미는 다음과 같습니다.

```text
[X] 이미 적용된 마이그레이션
[ ] 아직 적용되지 않은 마이그레이션
```

> 마이그레이션 생성 명령은 로컬 개발 환경에서만 실행합니다. EC2 test/dev 환경에서는 Git에 포함된 마이그레이션을 `migration:run`으로 적용합니다.

### docker compose

docker compose up -d --build