# DB Proxy

RisuAI의 sidecar 프로젝트.
RisuAI 소스코드를 수정하지 않고, HTTP 프록시 레이어와 SQLite를 사용하여 데이터 접근 성능을 개선한다.

## 런타임 환경

- **RisuAI를 Docker(Node 서버)로 구동하는 환경을 전제로 한다.**
- Node 서버 모드에서는 `globalThis.__NODE__ = true`가 주입되어, 브라우저에서 `isNodeServer = true`로 동작한다.
- 이 때문에 RisuAI 클라이언트의 저장 방식이 브라우저 단독 환경과 다르다:
  - 캐릭터 데이터는 `POST /api/write` (`file-path: remotes/{charId}.local.bin`)로 **별도 요청**으로 저장된다.
  - 메인 바이너리(`database/database.bin`)에는 캐릭터 실제 데이터 대신 REMOTE 메타데이터 블록(type 6)만 포함된다.

## 설계 우선순위

1. **P1 — 투명성**: risuai와의 통신이 반드시 성공해야 한다. 이 서버에 장애가 생겨도 클라이언트 요청은 risuai까지 도달해야 한다. risuai의 기존 HTTP API 인터페이스를 변경하거나 훼손하지 않는다.
2. **P2 — 독립 동작**: risuai + 이 서버만으로 완전히 동작해야 한다. Sync 서버 등 다른 사이드카 없이도 모든 기능이 정상 작동한다.
3. **P3 — 체이닝 호환**: Caddy 리버스 프록시, Sync 서버 등과 함께 사용될 때에도 정상 동작해야 한다.

## 핵심 제약

- **RisuAI 본체는 수정할 수 없다.** 제3자가 관리하는 별도 프로젝트이므로, DB Proxy 관련 기능/문제는 반드시 이 프로젝트(risu-files/custom-codes/with-sqlite/) 내에서 해결해야 한다.
- Sync 서버(risu-files/custom-codes/sync/)와는 독립적으로 동작한다. 체이닝 가능하지만 의존성은 없다.

## RisuAI Node 서버 HTTP API

모든 파일 I/O는 HTTP API를 경유한다:

- `GET /api/read` — `file-path` 헤더 (hex-encoded UTF-8), 응답: raw binary
- `POST /api/write` — `file-path` 헤더 (hex-encoded UTF-8), body: raw binary
- `GET /api/list` — 전체 파일 목록 (JSON)
- `GET /api/remove` — `file-path` 헤더로 파일 삭제

인증: ES256 JWT, `risu-auth` 헤더. DB Proxy는 클라이언트의 JWT를 upstream으로 그대로 패스스루한다.

파일 경로 인코딩: `Buffer.from(path, 'utf-8').toString('hex')` — 전체 경로를 한 번에 hex 인코딩한다. `/`, `.` 등도 hex로 변환된다.
예: `database/database.bin` → `64617461626173652f64617461626173652e62696e`

## 주요 파일 경로 패턴

- `database/database.bin` — 메인 데이터베이스 (RisuSave 바이너리)
- `database/dbbackup-{timestamp}.bin` — 자동 백업
- `remotes/{chaId}.local.bin` — 개별 캐릭터 파일 (Node 서버 모드)
- `coldstorage/{uuid}` — 압축된 채팅 히스토리 (확장자 없음)
- `assets/{id}.{ext}` — 이미지 등 에셋

## Docker 실행

Docker 구성은 `risu-files/custom-codes/risuai-network/` 레포에서 관리한다.
이 프로젝트 단독으로 `docker build/run`하지 않고, network 레포의 `docker-compose.yml`로 실행한다.

## 코딩 컨벤션

- TypeScript에서 `as` 타입단언을 사용하지 않는다. interface의 index signature, 제네릭, 타입 가드 등으로 해결한다.

## 테스트

- 신규 기능 추가, 리팩토링, 버그 수정 시 관련 테스트를 추가·수정한다.
- 테스트 파일은 소스 옆에 co-locate한다 (`parser.ts` → `parser.test.ts`).
- 코드 수정 후 반드시 `npm test`를 실행하여 전체 테스트가 통과하는지 확인한다.

## Cold Storage 메커니즘

RisuAI 클라이언트는 30일 이상 된 채팅을 cold storage로 이동:
- 마커: `\uEF01COLDSTORAGE\uEF01{uuid}`
- `preLoadChat()` 함수가 채팅 선택 시 on-demand 로딩
- Node 모드: `NodeStorage.getItem('coldstorage/' + key)` → `GET /api/read`
- DB Proxy는 이 메커니즘을 활용하여 초기 로딩을 최적화한다.
