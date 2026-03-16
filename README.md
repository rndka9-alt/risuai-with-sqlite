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
- **초기 로딩**: 캐릭터 메타데이터만 전송, 채팅은 on-demand 로딩

## 아키텍처

```
Client (Browser) → DB-Proxy (:3001) → RisuAI (:6001) → Filesystem
                        ↕
                     SQLite
```

Sync 서버와 체이닝 시:
```
Client → DB-Proxy (:3001) → Sync (:3000) → RisuAI (:6001) → Filesystem
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
1. SQLite 비어있음?
   → upstream GET /api/read (database.bin) → 파싱 → SQLite hydrate
   → 각 채팅 데이터를 upstream coldstorage에 write-back (FS 정합성)
   → remote 캐릭터 파일도 fetch → SQLite 저장

2. SQLite에 데이터 있음?
   → Reconciliation: upstream과 hash 비교 → drift 시 FS 기준 갱신
```

### Read Path

```
Client GET /api/read
├─ database.bin      → SQLite에서 slim 재조립 (채팅은 cold marker로 치환)
├─ remotes/*.bin     → SQLite에서 slim 재조립
├─ coldstorage/*     → SQLite에서 채팅 데이터 서빙 (fflate 압축)
└─ assets/*          → upstream 패스스루
```

**Slim Response**: RisuAI의 기존 Cold Storage 메커니즘을 활용.
채팅 메시지를 `\uEF01COLDSTORAGE\uEF01{id}` 마커로 교체하여 전송.
클라이언트가 채팅을 열면 `preLoadChat()` → `/api/read (coldstorage/...)` 로 on-demand 로딩.

### Write Path

```
Client POST /api/write
├─ database.bin / remotes/*.bin:
│   파싱 → cold marker인 채팅은 skip, 실제 데이터면 DB update
│   원본 blob → upstream forward
└─ 기타 → upstream 패스스루
```

### Reconciliation (주기적)

```
매 N분:
→ upstream에서 database.bin + remotes 읽기
→ 블록별 hash 비교
→ drift 발견 시 FS 기준으로 DB 갱신
→ cold storage 파일 정합성 확인
```

## DB 스키마

SQLite (better-sqlite3), WAL 모드.

```sql
CREATE TABLE blocks (
  name       TEXT PRIMARY KEY,
  type       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  hash       TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE chats (
  key        TEXT PRIMARY KEY,   -- '{chaId}_chat_{index}'
  char_id    TEXT NOT NULL,
  chat_index INTEGER NOT NULL,
  data       BLOB NOT NULL,      -- fflate 압축된 채팅 JSON
  hash       TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_chats_char ON chats(char_id);
CREATE INDEX idx_blocks_type ON blocks(type);
```

## 모듈 구조

```
src/
├── server/
│   ├── index.ts          # HTTP 프록시 서버, 라우팅
│   ├── config.ts         # 환경변수 로딩
│   ├── proxy.ts          # upstream forward (bypass의 기본 동작)
│   ├── circuit-breaker.ts # 실패 감지, bypass 모드 전환
│   ├── db.ts             # SQLite 연결, CRUD, 마이그레이션
│   ├── parser.ts         # RisuSave 바이너리 파싱
│   ├── assembler.ts      # 블록 → RisuSave 바이너리 재조립
│   ├── slim.ts           # Slim response 생성 (chat → cold marker)
│   ├── write-handler.ts  # Write 인터셉트 (marker skip 로직)
│   ├── cold-compat.ts    # Cold storage 호환 (fflate 압축/해제)
│   └── reconcile.ts      # 주기적 FS↔DB 정합성 검사
└── shared/
    └── types.ts          # 공유 타입 정의
```

## 설정

```env
PORT=3001                        # DB Proxy 리슨 포트
UPSTREAM=http://localhost:6001   # RisuAI (또는 Sync 서버) 주소
DB_PATH=./data/proxy.db          # SQLite 파일 경로
RECONCILE_INTERVAL_MS=300000     # 정합성 검사 주기 (기본 5분)
```

## 실행

```bash
npm install
npm run build
npm start
```

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
3. **Reconciliation**: 주기적으로 FS 상태와 DB 비교, FS 기준으로 보정

→ DB Proxy를 제거하더라도, FS에 cold storage 파일이 존재하므로 RisuAI가 정상 동작.
