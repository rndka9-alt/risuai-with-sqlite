# RisuAI DB Proxy

RisuAI Node/Docker 환경을 위한 SQLite 기반 데이터 접근 프록시.
RisuAI 코드를 수정하지 않고, HTTP 리버스 프록시로 데이터 읽기/쓰기 성능을 개선한다.

## 배경

RisuAI Node 서버 모드는 모든 데이터를 파일시스템에 저장한다.
클라이언트가 데이터를 요청할 때마다 `database.bin` 전체를 읽고,
저장할 때마다 전체를 쓴다. 캐릭터/채팅이 많아지면 성능이 급격히 저하된다.

DB Proxy는 이 파일시스템 레이어 앞에 SQLite를 두어:
- **Read**: DB에서 즉시 서빙 (upstream 파일 I/O 회피)
- **Write**: DB 업데이트 후 upstream에 forward (FS 정합성 유지)
- **초기 로딩**: 캐릭터 이름/이미지만 전송, 나머지는 백그라운드 로딩

## 필수 설정: Remote Saving 활성화

DB Proxy의 핵심 최적화(Deep Slim, Batch Remotes 등)는 캐릭터 데이터가
**개별 파일**(`remotes/{chaId}.local.bin`)로 저장되어야 동작한다.

RisuAI는 Node 서버 모드에서도 **Remote Saving이 꺼져 있으면** 모든 캐릭터를
`database.bin` 하나에 몰아서 저장한다.
이 상태에서 DB Proxy는 투명 프록시 역할만 하며, 성능 이점이 거의 없다.

**켜는 방법**: Settings → Advanced → **Enable Remote Saving** 체크

| Remote Saving | 저장 방식 | DB Proxy 효과 |
|:---:|---|---|
| OFF (기본값) | 모든 캐릭터가 `database.bin` 하나에 포함 | 투명 프록시만 동작, 최적화 없음 |
| **ON** | 캐릭터별 `remotes/*.local.bin` 분리 저장 | Deep Slim · Batch Remotes · Cold Storage 전부 활성 |

> Remote Saving을 켠 뒤 최초 저장 시, 기존 `database.bin`에 내장되어 있던
> 캐릭터 데이터가 개별 remote 파일로 마이그레이션된다. 이 과정은 자동이며 데이터 유실은 없다.

## 아키텍처

```
Client (Browser) → DB-Proxy (:3001) → RisuAI (:6001) → Filesystem
                        ↕
                     SQLite
```

Sync 서버와 체이닝 시:
```
Client → Sync (:3000) → DB-Proxy (:3001) → RisuAI (:6001) → Filesystem
                              ↕
                           SQLite
```

### 핵심 원칙

| 원칙 | 설명 |
|------|------|
| Bypass-first | DB Proxy의 기본 동작은 투명 프록시. SQLite 가속은 부가 기능. 처리 중 실패 시 upstream 직통 |
| Write-through | 쓰기 → DB 업데이트 → upstream forward (FS 기록은 RisuAI가 담당) |
| Read from DB | 읽기 → DB에서 서빙. 초기 hydrate 이후 upstream 안 감 |
| FS = Boot source of truth | 기동 시 FS의 데이터를 파싱해서 DB hydrate |
| API 투명성 | `/api/read`, `/api/write` 인터페이스 불변. 클라이언트 수정 없음 |

## Failure Bypass

DB Proxy는 **실패 시 upstream 직통**을 보장한다.

### 요청 단위 bypass

모든 요청 핸들러는 try-catch로 감싸져 있으며,
SQLite 조회/파싱/재조립 중 어떤 단계에서든 실패하면 즉시 upstream으로 원본 요청을 forward한다.

```
Client → DB-Proxy
           ├─ [성공] SQLite에서 처리 → 응답
           └─ [실패] catch → upstream forward → 응답 (투명 프록시 동작)
```

### Circuit breaker

연속 N회 실패 시 일정 시간 동안 전체 bypass 모드로 전환:

```
상태: CLOSED (정상)
  → 요청마다 SQLite 가속 시도
  → 실패 시 fallback + 실패 카운터 증가

상태: OPEN (bypass 모드)
  → 모든 요청을 upstream 직통
  → 일정 시간(예: 30초) 후 HALF-OPEN

상태: HALF-OPEN (탐색)
  → 단일 요청만 SQLite 시도
  → 성공 → CLOSED, 실패 → OPEN
```

### Hydration 실패

기동 시 upstream에서 데이터를 가져오지 못하면:
- SQLite 없이 **순수 프록시 모드**로 시작
- 백그라운드에서 주기적으로 hydration 재시도
- hydration 성공 시 자동으로 가속 모드 전환

## 데이터 흐름

### Proxy 기동

```
Lazy Hydration (클라이언트 트래픽 기반):
1. COLD 상태로 시작 (SQLite 비어있음, 모든 요청 bypass)
2. 첫 번째 read 요청 → tee로 upstream 응답 캡처 → SQLite에 저장 → WARMING
3. 모든 remote 캐릭터 캡처 완료 → HOT (이후 SQLite에서 서빙)
4. HOT 상태에서 bypass 발생 시 → hash 비교 → drift 보정 (passive reconciliation)
```

### Read Path

```
Client GET /api/read
├─ database.bin      → SQLite에서 slim 재조립 (채팅은 cold marker로 치환)
├─ remotes/*.bin     → SQLite에서 deep-slim 재조립 (채팅 + 무거운 필드 모두 제거)
├─ coldstorage/*     → SQLite에서 채팅 데이터 서빙 (fflate 압축)
└─ assets/*          → upstream 패스스루
```

**2-Phase Slim Response**:

| Phase | 대상 | 처리 |
|-------|------|------|
| Chat Slim | `chats[]` 배열 | 채팅 메시지를 cold marker로 교체. 클라이언트의 `preLoadChat()` → `coldstorage/` 로 on-demand 로딩 |
| Deep Slim | 29개 heavy fields | `desc`, `systemPrompt`, `globalLore`, `triggerscript` 등을 빈 값으로 교체. `char_details` 테이블에 gzip 압축 저장. `__strippedFields` 마커 배열 삽입 |

Deep Slim 후 클라이언트에 전달되는 캐릭터 데이터:
- 유지: `name`, `image`, `type`, `chaId`, `creatorNotes`, `tags`, `trashTime` 등 UI 표시용 필드
- 제거: `desc`, `systemPrompt`, `personality`, `scenario`, `globalLore`, `firstMessage` 등 29개 필드
- 클라이언트 JS가 백그라운드에서 `/db/char-details` 호출 → 메모리에 merge → `__strippedFields` 제거

### Write Path

```
Client POST /api/write
├─ database.bin:
│   파싱 → incremental block upsert → upstream forward
├─ remotes/*.bin:
│   1. __strippedFields 감지 시 → 저장된 detail과 merge하여 완전한 데이터 복원
│   2. 복원된 데이터를 upstream에 forward (FS에는 항상 완전한 데이터 저장)
│   3. Background: chat slim → deep slim → SQLite 저장
└─ 기타 → upstream 패스스루
```

`__strippedFields` merge는 클라이언트가 detail을 아직 로딩하지 않은 상태에서 저장해도 데이터 유실이 없도록 보장한다.

### Streaming (proxy2)

```
Client POST /proxy2 (LLM 요청)
  1. x-dbproxy-target-char 헤더로 대상 캐릭터 식별
  2. job 생성 → SQLite에 저장
  3. upstream forward → SSE 스트리밍 감지
  4. 메모리 activeStreams에서 라이브 추적 + SQLite에 주기적 persist
  5. 페이지 새로고침 시 GET /db/jobs/{id}/stream으로 SSE 재연결
  6. 완료 후 POST /db/jobs/{id}/consume → 삭제
```

## 클라이언트 번들

RisuAI HTML에 `<script defer src="/db/client.js">` 를 자동 주입한다.

| 모듈 | 역할 |
|------|------|
| `batch-remotes.ts` | 기동 시 `/db/batch-remotes`로 전체 remote 캐릭터를 한 번에 prefetch, fetch-patch에서 개별 read 요청을 캐시에서 서빙 |
| `fetch-patch.ts` | fetch 패치: `/proxy2` 요청에 target-char 헤더 주입 + job ID 캡처, `/api/list` 응답 캐싱, remote 파일 읽기를 batch cache에서 서빙 |
| `detail-loader.ts` | 풀스크린 로딩 오버레이 + deep-slim detail 백그라운드 fetch → 메모리 merge |
| `recovery.ts` | 페이지 새로고침 후 streaming job 복구 (SSE 재연결, 완료 job 적용) |
| `notification.ts` | 토스트 알림 UI |

`detail-loader`는 `__pluginApis__.getDatabase()`를 통해 RisuAI의 인메모리 DB에 직접 접근하여 stripped 필드를 복원한다. 로딩 완료 전까지 풀스크린 오버레이로 유저 인터렉션을 차단한다.

## API 엔드포인트

### File API (RisuAI 호환)

| 경로 | 메서드 | 설명 |
|------|--------|------|
| `/api/read` | GET | 파일 읽기 (database.bin, remotes, coldstorage, assets) |
| `/api/write` | POST | 파일 쓰기 (write-through + background slim) |

### DB Proxy 전용

| 경로 | 메서드 | 설명 |
|------|--------|------|
| `/db/client.js` | GET | 클라이언트 번들 (IIFE) |
| `/db/batch-remotes` | GET | 전체 remote 캐릭터를 한 번에 반환 (바이너리) |
| `/db/char-detail/{charId}` | GET | 개별 캐릭터의 stripped detail 반환 (JSON) |
| `/db/char-details` | GET | 전체 캐릭터 detail 일괄 반환 (JSON) |
| `/db/jobs/active` | GET | 활성 streaming job 목록 |
| `/db/jobs/{id}/stream` | GET | SSE 재연결 (replay + live) |
| `/db/jobs/{id}/abort` | POST | 스트리밍 중단 |
| `/db/jobs/{id}/consume` | POST | job 삭제 |
| `/proxy2` | POST | LLM 스트리밍 프록시 (SSE 버퍼링 + job 관리) |
| `/.proxy/config` | GET | 프록시 체이닝 설정 (usePlainFetch 등 런타임 상태, downstream 병합) |

### `/.proxy/config` 체이닝 엔드포인트

`/.proxy/*` 경로는 프록시 체인 전체가 공유하는 네임스페이스다.
각 프록시 서버가 요청을 downstream으로 전달한 뒤, 응답에 자기 데이터를 merge하여 반환한다.

```
Client → sync → with-sqlite → risuai (404)
                                 ↓
                    { withSqlite: { ... } }   ← with-sqlite가 생성
               ↓
  { sync: { ... }, withSqlite: { ... } }      ← sync가 merge
```

- downstream이 404를 반환하면 `{}`에서 시작하고, 200이면 기존 JSON에 자기 키를 추가한다.
- 프록시 수에 무관하게 클라이언트는 단일 요청으로 전체 프록시 상태를 받는다.
- 새로운 프록시를 체인에 추가할 때 동일 패턴으로 자기 키만 merge하면 된다.

## DB 스키마

SQLite (better-sqlite3), WAL 모드.

```sql
CREATE TABLE blocks (
  name        TEXT PRIMARY KEY,
  type        INTEGER NOT NULL,
  source      TEXT NOT NULL,       -- 'database.bin' or 'remote:{chaId}'
  compression INTEGER NOT NULL DEFAULT 0,
  data        BLOB NOT NULL,
  hash        TEXT NOT NULL,
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE chats (
  uuid        TEXT PRIMARY KEY,    -- cold storage UUID
  char_id     TEXT NOT NULL,
  chat_index  INTEGER NOT NULL,
  data        BLOB NOT NULL,       -- gzip 압축된 채팅 JSON (fflate 호환)
  hash        TEXT NOT NULL,
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE char_details (
  char_id     TEXT PRIMARY KEY,    -- 캐릭터 ID
  data        BLOB NOT NULL,       -- gzip 압축된 heavy fields JSON
  hash        TEXT NOT NULL,
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,    -- streaming job UUID
  char_id     TEXT,                -- 대상 캐릭터
  status      TEXT NOT NULL DEFAULT 'streaming',  -- streaming/completed/failed/aborted
  response    TEXT NOT NULL DEFAULT '',
  error       TEXT,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_blocks_type ON blocks(type);
CREATE INDEX idx_blocks_source ON blocks(source);
CREATE INDEX idx_chats_char ON chats(char_id);
```

## 모듈 구조

```
src/
├── client/                    # 브라우저 IIFE 번들 (RisuAI HTML에 주입)
│   ├── index.ts              # 진입점: batch-remotes + fetch-patch + detail-loader + recovery 연결
│   ├── batch-remotes.ts      # /db/batch-remotes로 전체 remote 캐릭터 prefetch + 캐시
│   ├── fetch-patch.ts        # fetch 패치 (proxy2 헤더 주입, /api/list 캐싱, batch cache 서빙)
│   ├── detail-loader.ts      # 풀스크린 오버레이 + deep-slim detail 백그라운드 로딩
│   ├── recovery.ts           # 페이지 새로고침 후 streaming job 복구
│   └── notification.ts       # 토스트 UI
├── server/
│   ├── index.ts              # HTTP 프록시 서버, 라우팅, hydration 상태 관리
│   ├── config.ts             # 환경변수 로딩
│   ├── proxy.ts              # upstream forward (bypass의 기본 동작)
│   ├── circuit-breaker.ts    # 실패 감지, bypass 모드 전환
│   ├── db.ts                 # SQLite 연결, CRUD (blocks, chats, char_details, jobs)
│   ├── logger.ts             # 로그 레벨 관리 (debug/info/warn/error)
│   ├── parser.ts             # RisuSave 바이너리 파싱
│   ├── assembler.ts          # 블록 → RisuSave 바이너리 재조립
│   ├── slim.ts               # Chat cold storage + Deep slim (29개 heavy fields 분리)
│   ├── write-handler.ts      # Write 인터셉트 (__strippedFields merge + re-slim)
│   ├── cold-compat.ts        # Cold storage 호환 (fflate 압축/해제)
│   ├── reconcile.ts          # Passive FS↔DB 정합성 검사 (bypass 시 hash 비교)
│   ├── stream-buffer.ts      # /proxy2 SSE 스트리밍 + job 관리
│   ├── client-bundle.ts      # client.js 로딩 + HTML script 주입
│   ├── parser.test.ts        # parser 테스트
│   └── slim.test.ts          # slim/deepSlim/merge 테스트
└── shared/
    └── types.ts              # RisuSaveType enum, ParsedBlock, Job 등 공유 타입
```

## 설정

```env
PORT=3001                        # DB Proxy 리슨 포트
UPSTREAM=http://localhost:6001   # RisuAI (또는 Sync 서버) 주소
DB_PATH=./data/proxy.db          # SQLite 파일 경로
LOG_LEVEL=info                   # 로그 레벨 (debug/info/warn/error)
CB_FAILURE_THRESHOLD=5           # Circuit breaker 실패 임계값
CB_RESET_TIMEOUT_MS=30000        # Circuit breaker 리셋 타임아웃 (ms)
```

## 실행

```bash
npm install
npm run build
npm start
```

## 테스트

```bash
npm test             # vitest run (전체)
npm run test:watch   # vitest watch 모드
npm run typecheck    # tsc --noEmit
```

테스트 파일은 소스 옆에 co-locate한다 (`slim.ts` → `slim.test.ts`).

## Docker

```bash
docker build -t risu-db-proxy .
docker run -p 3001:3001 \
  -e UPSTREAM=http://risuai:6001 \
  -v risu-db-data:/data \
  risu-db-proxy
```

### 볼륨 마운트

SQLite 파일은 **반드시 외부 마운트**해야 한다:

```yaml
# docker-compose.yml 예시
services:
  db-proxy:
    build: .
    ports:
      - "3001:3001"
    environment:
      - UPSTREAM=http://risuai:6001
      - DB_PATH=/data/proxy.db
    volumes:
      - db-proxy-data:/data        # Named volume (권장)
      # - ./data:/data             # 또는 호스트 바인드 마운트

volumes:
  db-proxy-data:
```

| 저장소 | 위치 | 유실 시 |
|--------|------|---------|
| SQLite (proxy.db) | `/data/` (외부 마운트) | 기동 시 upstream에서 재hydrate. 데이터 유실 없음, 기동 시간만 증가 |
| WAL 파일 (proxy.db-wal) | `/data/` (자동 생성) | SQLite가 자동 복구 |
| upstream FS | RisuAI 컨테이너 `/app/save/` | Source of truth. 이건 유실되면 안 됨 |

## FS 정합성 보장

DB Proxy가 없어도 데이터가 유실되지 않도록 설계:

1. **Write-back**: Slim response 생성 시 채팅 데이터를 upstream의 `coldstorage/`에도 실제로 저장
2. **Write-through**: 모든 쓰기를 upstream에 forward하여 FS에도 반영
3. **Detail merge**: `__strippedFields`가 있는 write 요청은 저장된 detail과 merge 후 upstream에 전달 → FS에 항상 완전한 데이터 보장
4. **Passive reconciliation**: bypass 발생 시 upstream 응답과 SQLite의 hash를 비교, drift 보정

→ DB Proxy를 제거하더라도, FS에 cold storage 파일이 존재하므로 RisuAI가 정상 동작.
