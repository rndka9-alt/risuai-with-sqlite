/**
 * with-sqlite v2 데이터베이스 스키마.
 *
 * 설계 원칙:
 * - 모든 RisuAI 필드는 개별 컬럼으로 매핑 (JSON 짬통 금지)
 * - 값이 JSON 구조체인 컬럼은 허용 (e.g. global_lore TEXT — 배열 자체가 값)
 * - with-sqlite 관리 필드는 __ws_ prefix
 * - 소프트 딜리트: __ws_deleted_at
 * - 미지의 필드 → 경고 로그 → 마이그레이션으로 컬럼 추가
 *
 * 네이밍 규칙:
 *   __ws_*          with-sqlite 내부 관리 필드
 *   snake_case       RisuAI 필드 (camelCase → snake_case 변환)
 *   원본 이름 유지   RisuAI 오타도 그대로 보존 (e.g. extentions)
 *
 * 타임스탬프: ISO 8601 TEXT (e.g. '2026-03-26T22:30:15.123Z')
 * ID 생성: lower(hex(randomblob(16))) — 32자 hex
 */

export const SCHEMA_VERSION = 3;

export const DDL = `

-- ═══════════════════════════════════════════════════════════════════
-- characters
-- ═══════════════════════════════════════════════════════════════════
-- Source: remotes/{chaId}.local.bin
-- RisuAI Node 서버 모드에서 각 캐릭터/그룹은 별도 파일로 저장된다.
-- character 인터페이스와 groupChat 인터페이스를 하나의 테이블에 통합.
-- type 컬럼으로 구분: 'character' | 'group'
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS characters (

  -- ── with-sqlite 관리 ──────────────────────────────────────────
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_hash         TEXT,           -- 원본 JSON 전체의 SHA-256. 변경 감지 및 reconciliation용
  __ws_source_file  TEXT,           -- RisuAI 원본 파일 경로. e.g. 'remotes/abc-123.local.bin'
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- ── 기본 메타데이터 ───────────────────────────────────────────
  -- character.chaId / groupChat.chaId
  -- 캐릭터 고유 식별자. RisuAI가 생성하는 UUID.
  char_id           TEXT,

  -- character.type / groupChat.type
  -- 'character' 또는 'group'. 이 값으로 character vs groupChat 구분.
  type              TEXT,

  -- character.name / groupChat.name
  -- 캐릭터 표시 이름. 목록 화면에서 사용.
  name              TEXT DEFAULT '',

  -- character.chatPage / groupChat.chatPage
  -- 현재 활성화된 채팅 세션 인덱스. chats[] 배열의 인덱스.
  chat_page         INTEGER DEFAULT 0,

  -- character.viewScreen / groupChat.viewScreen
  -- 캐릭터: 'emotion'|'none'|'imggen'
  -- 그룹: 'single'|'multiple'|'none'|'emp'
  view_screen       TEXT,

  -- character.tags
  -- 캐릭터 태그 배열. JSON string[]. e.g. '["fantasy","female"]'
  tags              TEXT DEFAULT '[]',

  -- character.creator
  -- 캐릭터 카드 제작자 이름.
  creator           TEXT,

  -- character.creatorNotes / groupChat.creatorNotes
  -- 제작자가 작성한 캐릭터 설명 노트.
  creator_notes     TEXT,

  -- character.characterVersion
  -- 캐릭터 카드 버전 문자열. e.g. '1.0'
  character_version TEXT,

  -- character.nickname
  -- 사용자가 지정한 캐릭터 별명. 표시 이름을 덮어쓴다.
  nickname          TEXT,

  -- character.utilityBot
  -- true면 유틸리티 봇 (채팅 목적이 아닌 도구용 캐릭터).
  utility_bot       INTEGER,        -- boolean: 0|1

  -- character.removedQuotes / groupChat.removedQuotes
  -- true면 AI 응답에서 따옴표 자동 제거.
  removed_quotes    INTEGER,        -- boolean: 0|1

  -- character.firstMsgIndex / groupChat.firstMsgIndex
  -- 첫 메시지로 사용할 alternateGreetings 인덱스. -1이면 firstMessage 사용.
  first_msg_index   INTEGER,

  -- character.chatFolders / groupChat.chatFolders
  -- 채팅 세션 폴더 구조. JSON ChatFolder[].
  -- e.g. '[{"id":"abc","name":"Folder 1","folded":false}]'
  chat_folders      TEXT DEFAULT '[]',

  -- character.reloadKeys / groupChat.reloadKeys
  -- UI 리렌더링 트리거 카운터. 값이 바뀌면 Svelte 리액티비티 발동.
  reload_keys       INTEGER,

  -- character.additionalData
  -- V2 캐릭터 카드 사양의 추가 메타데이터. JSON object.
  -- e.g. '{"tag":["romance"],"creator":"Alice","character_version":"2.0"}'
  additional_data   TEXT DEFAULT '{}',

  -- character.license
  -- 캐릭터 카드 라이선스. e.g. 'CC BY-NC-SA 4.0'
  license           TEXT,

  -- character.private
  -- true면 비공개 캐릭터 (Realm 공유 시 노출 안 됨).
  private           INTEGER,        -- boolean: 0|1

  -- character.realmId
  -- Realm(온라인 공유 플랫폼)에서의 캐릭터 ID.
  realm_id          TEXT,

  -- character.imported
  -- true면 외부에서 임포트된 캐릭터.
  imported          INTEGER,        -- boolean: 0|1

  -- character.trashTime / groupChat.trashTime
  -- 휴지통에 넣은 시각 (Unix timestamp ms). null이면 휴지통 아님.
  trash_time        INTEGER,

  -- character.source
  -- 캐릭터 원본 소스 URL 배열. JSON string[].
  source            TEXT DEFAULT '[]',

  -- character.creation_date
  -- 캐릭터 생성 시각 (Unix timestamp ms). 캐릭터 카드 스펙.
  creation_date     INTEGER,

  -- character.modification_date
  -- 캐릭터 최종 수정 시각 (Unix timestamp ms). 캐릭터 카드 스펙.
  modification_date INTEGER,

  -- character.lastInteraction
  -- 마지막 채팅 시각 (Unix timestamp ms). 최근 대화 정렬용.
  last_interaction  INTEGER,

  -- character.modules
  -- 활성화된 모듈 ID 배열. JSON string[]. e.g. '["mod-abc","mod-def"]'
  modules           TEXT DEFAULT '[]',

  -- ── 프롬프트 (LLM 컨텍스트 구성) ─────────────────────────────
  -- character.firstMessage / groupChat.firstMessage
  -- 대화 시작 시 캐릭터의 첫 메시지. 가장 먼저 채팅에 표시되는 텍스트.
  first_message     TEXT DEFAULT '',

  -- character.desc
  -- 캐릭터 설명. LLM 컨텍스트에 주입되는 캐릭터 묘사.
  "desc"            TEXT DEFAULT '',

  -- character.notes
  -- 추가 노트. 시나리오 보조 텍스트로 LLM에 전달.
  notes             TEXT DEFAULT '',

  -- character.personality
  -- 성격 설명. 캐릭터의 성격 특성을 기술.
  personality       TEXT DEFAULT '',

  -- character.scenario
  -- 상황 설정. 대화가 일어나는 배경/맥락 설명.
  scenario          TEXT DEFAULT '',

  -- character.systemPrompt / groupChat에는 없음
  -- 시스템 프롬프트. LLM에 전달되는 최상위 지시문.
  system_prompt     TEXT DEFAULT '',

  -- character.postHistoryInstructions
  -- 채팅 히스토리 뒤에 삽입되는 지시문. jailbreak/reminder 용도.
  post_history_instructions TEXT DEFAULT '',

  -- character.exampleMessage / groupChat.exampleMessage (타입에 optional)
  -- 대화 예시. few-shot 형태로 LLM에 전달되는 샘플 대화.
  example_message   TEXT DEFAULT '',

  -- character.alternateGreetings / groupChat.alternateGreetings
  -- 대체 인사 메시지 배열. JSON string[]. 사용자가 선택 가능.
  alternate_greetings TEXT DEFAULT '[]',

  -- character.depth_prompt
  -- depth 기반 프롬프트. JSON object.
  -- e.g. '{"depth":4,"prompt":"Remember: ..."}'
  depth_prompt      TEXT DEFAULT '{}',

  -- character.bias
  -- 토큰 바이어스 설정. JSON [string, number][] 배열.
  -- e.g. '[["bad_word",-100],["good_word",5]]'
  bias              TEXT DEFAULT '[]',

  -- character.replaceGlobalNote / groupChat.replaceGlobalNote
  -- 이 값이 있으면 글로벌 노트를 대체함.
  replace_global_note TEXT DEFAULT '',

  -- character.additionalText / groupChat.additionalText (없을 수 있음)
  -- 추가 텍스트. 캐릭터 카드의 보조 텍스트 필드.
  additional_text   TEXT DEFAULT '',

  -- character.translatorNote
  -- 번역자 노트. 캐릭터 카드 번역 시 참고용.
  translator_note   TEXT,

  -- ── 로어/월드빌딩 ─────────────────────────────────────────────
  -- character.globalLore / groupChat.globalLore
  -- 글로벌 로어북 항목 배열. JSON loreBook[].
  -- 키워드 매칭 시 LLM 컨텍스트에 동적 삽입.
  global_lore       TEXT DEFAULT '[]',

  -- character.loreSettings / groupChat.loreSettings
  -- 로어 스캔 설정. JSON object.
  -- e.g. '{"tokenBudget":2048,"scanDepth":5,"recursiveScanning":true}'
  lore_settings     TEXT DEFAULT '{}',

  -- character.loreExt
  -- 로어 확장 데이터. JSON any. 플러그인/모듈이 사용하는 로어 확장.
  lore_ext          TEXT DEFAULT '[]',

  -- character.lorePlus / groupChat.lorePlus
  -- true면 로어북 Plus 모드 활성화.
  lore_plus         INTEGER,        -- boolean: 0|1

  -- ── 스크립트 ──────────────────────────────────────────────────
  -- character.customscript / groupChat.customscript
  -- CBS(Custom Bot Script) 배열. JSON customscript[].
  -- 조건부 텍스트 삽입, 변수 조작 등 자동화 스크립트.
  customscript      TEXT DEFAULT '[]',

  -- character.triggerscript
  -- 트리거 스크립트 배열. JSON triggerscript[].
  -- 특정 이벤트(메시지 전송, 생성 완료 등)에 반응하는 스크립트.
  triggerscript     TEXT DEFAULT '[]',

  -- character.virtualscript / groupChat.virtualscript
  -- Lua 가상 스크립트. 캐릭터별 Lua 코드.
  virtualscript     TEXT DEFAULT '',

  -- character.scriptstate
  -- 스크립트 실행 상태. JSON {[key:string]: string|number|boolean}.
  -- CBS/트리거 스크립트의 변수 저장소.
  scriptstate       TEXT DEFAULT '{}',

  -- ── UI/스타일 ─────────────────────────────────────────────────
  -- character.backgroundHTML / groupChat.backgroundHTML
  -- 채팅 화면 배경 HTML. 커스텀 배경 렌더링.
  background_html   TEXT DEFAULT '',

  -- character.backgroundCSS / groupChat.backgroundCSS
  -- 채팅 화면 배경 CSS. 커스텀 스타일링.
  background_css    TEXT DEFAULT '',

  -- character.largePortrait
  -- true면 캐릭터 초상화를 큰 사이즈로 표시.
  large_portrait    INTEGER,        -- boolean: 0|1

  -- character.inlayViewScreen
  -- true면 인레이 뷰 스크린 모드 활성화.
  inlay_view_screen INTEGER,        -- boolean: 0|1

  -- character.hideChatIcon / groupChat.hideChatIcon
  -- true면 채팅 화면에서 캐릭터 아이콘 숨김.
  hide_chat_icon    INTEGER,        -- boolean: 0|1

  -- ── 생성 설정 (이미지 생성) ───────────────────────────────────
  -- character.sdData
  -- Stable Diffusion 프롬프트 설정. JSON [string, string][] 배열.
  -- e.g. '[["positive","1girl, ..."],["negative","bad quality, ..."]]'
  sd_data           TEXT DEFAULT '[]',

  -- character.newGenData
  -- 신규 이미지 생성 설정. JSON object.
  -- e.g. '{"prompt":"...","negative":"...","instructions":"...","emotionInstructions":"..."}'
  new_gen_data      TEXT DEFAULT '{}',

  -- ── TTS (음성 합성) ───────────────────────────────────────────
  -- character.ttsMode
  -- TTS 엔진 선택. e.g. 'voicevox', 'naitts', 'gptsovits', 'oai', 'off'
  tts_mode          TEXT,

  -- character.ttsSpeech / groupChat.ttsSpeech
  -- TTS 음성 ID 또는 설정 문자열.
  tts_speech        TEXT,

  -- character.voicevoxConfig / groupChat.voicevoxConfig
  -- VOICEVOX 음성 합성 설정. JSON object.
  -- e.g. '{"speaker":"1","SPEED_SCALE":1.0,"PITCH_SCALE":0.0}'
  voicevox_config   TEXT DEFAULT '{}',

  -- character.naittsConfig / groupChat.naittsConfig
  -- NaiTTS 음성 합성 설정. JSON object.
  naitts_config     TEXT DEFAULT '{}',

  -- character.gptSoVitsConfig / groupChat.gptSoVitsConfig
  -- GPT-SoVITS 음성 합성 설정. JSON object.
  -- 참조 오디오, 언어, 속도 등 상세 설정 포함.
  gpt_sovits_config TEXT DEFAULT '{}',

  -- character.fishSpeechConfig / groupChat.fishSpeechConfig
  -- Fish Speech 음성 합성 설정. JSON object.
  fish_speech_config TEXT DEFAULT '{}',

  -- character.hfTTS / groupChat.hfTTS
  -- HuggingFace TTS 설정. JSON object. e.g. '{"model":"...","language":"ko"}'
  hf_tts            TEXT DEFAULT '{}',

  -- character.vits / groupChat.vits
  -- VITS ONNX 모델 파일 설정. JSON OnnxModelFiles.
  vits              TEXT DEFAULT '{}',

  -- character.oaiVoice
  -- OpenAI TTS 음성 ID. e.g. 'alloy', 'echo', 'fable'
  oai_voice         TEXT,

  -- character.ttsReadOnlyQuoted / groupChat.ttsReadOnlyQuoted
  -- true면 따옴표 안의 텍스트만 TTS 읽기.
  tts_read_only_quoted INTEGER,     -- boolean: 0|1

  -- ── 기타 설정 ─────────────────────────────────────────────────
  -- character.supaMemory / groupChat.supaMemory
  -- true면 HYPA(장기 메모리 요약) 기능 활성화.
  supa_memory       INTEGER,        -- boolean: 0|1

  -- character.extentions (RisuAI 원본 오타 그대로 보존)
  -- 확장 데이터 저장소. JSON {[key:string]: any}.
  -- 서드파티 확장이 임의 데이터를 저장하는 용도.
  extentions        TEXT DEFAULT '{}',

  -- character.defaultVariables
  -- CBS 기본 변수. JSON string 또는 object.
  default_variables TEXT DEFAULT '',

  -- character.group_only_greetings
  -- 그룹 채팅에서만 사용되는 인사 메시지 배열. JSON string[].
  group_only_greetings TEXT DEFAULT '[]',

  -- character.lowLevelAccess / groupChat.lowLevelAccess
  -- true면 저수준 프롬프트 접근 허용 (고급 사용자용).
  low_level_access  INTEGER,        -- boolean: 0|1

  -- character.doNotChangeSeperateModels (RisuAI 원본 오타 그대로 보존)
  -- true면 개별 모델 설정을 글로벌로 덮어쓰지 않음.
  do_not_change_seperate_models INTEGER, -- boolean: 0|1

  -- character.escapeOutput
  -- true면 AI 출력을 HTML 이스케이프 처리.
  escape_output     INTEGER,        -- boolean: 0|1

  -- character.prebuiltAssetCommand
  -- true면 프리빌트 에셋 명령어 활성화.
  prebuilt_asset_command INTEGER,    -- boolean: 0|1

  -- character.prebuiltAssetStyle
  -- 프리빌트 에셋 스타일 문자열.
  prebuilt_asset_style TEXT,

  -- character.prebuiltAssetExclude
  -- 프리빌트 에셋 제외 목록. JSON string[].
  prebuilt_asset_exclude TEXT DEFAULT '[]',

  -- ── 그룹 전용 필드 ────────────────────────────────────────────
  -- groupChat.characters
  -- 그룹에 포함된 캐릭터 chaId 배열. JSON string[].
  -- type='group'일 때만 사용.
  group_characters  TEXT DEFAULT '[]',

  -- groupChat.characterTalks
  -- 각 캐릭터의 발화 가중치. JSON number[]. characters와 같은 인덱스.
  group_character_talks TEXT DEFAULT '[]',

  -- groupChat.characterActive
  -- 각 캐릭터의 활성 상태. JSON boolean[]. characters와 같은 인덱스.
  group_character_active TEXT DEFAULT '[]',

  -- groupChat.autoMode
  -- true면 자동 대화 모드 (캐릭터가 번갈아 자동 발화).
  group_auto_mode   INTEGER,        -- boolean: 0|1

  -- groupChat.useCharacterLore
  -- true면 그룹 내 개별 캐릭터의 로어북도 사용.
  group_use_character_lore INTEGER,  -- boolean: 0|1

  -- groupChat.suggestMessages
  -- 그룹 채팅 제안 메시지 배열. JSON string[].
  group_suggest_messages TEXT DEFAULT '[]',

  -- groupChat.orderByOrder
  -- true면 캐릭터 발화 순서를 배열 순서대로 고정.
  group_order_by_order INTEGER,     -- boolean: 0|1

  -- groupChat.oneAtTime
  -- true면 한 번에 한 캐릭터만 발화.
  group_one_at_time INTEGER         -- boolean: 0|1
);

CREATE INDEX IF NOT EXISTS idx_characters_char_id ON characters(char_id);
CREATE INDEX IF NOT EXISTS idx_characters_type ON characters(type);
CREATE INDEX IF NOT EXISTS idx_characters_deleted ON characters(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- chat_sessions
-- ═══════════════════════════════════════════════════════════════════
-- Source: remotes/{chaId}.local.bin → character.chats[] 배열의 각 원소
-- RisuAI는 채팅을 캐릭터 JSON 안의 chats[] 배열로 저장한다.
-- 30일 이상 된 채팅은 cold storage로 이동되며,
-- 원본 위치에는 마커(\\uEF01COLDSTORAGE\\uEF01{uuid})가 남는다.
-- cold storage 파일: coldstorage/{uuid}
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_character_id TEXT,           -- → characters.__ws_id. 이 세션이 속한 캐릭터.
  __ws_hash         TEXT,           -- 세션 데이터의 SHA-256. cold storage 동기화 시 변경 감지.
  __ws_source_file  TEXT,           -- cold storage 파일 경로. e.g. 'coldstorage/550e8400-...'
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- Chat.uuid (RisuAI cold storage에서 부여하는 UUID)
  -- cold storage 마커와 연결되는 키. coldstorage/{uuid}로 파일 접근.
  uuid              TEXT,

  -- chats[] 배열 내 인덱스. 세션 순서 복원용.
  chat_index        INTEGER,

  -- Chat.hypaV2Data
  -- HYPA v2 장기 메모리 데이터. JSON object.
  -- e.g. '{"chunks":[],"mainChunks":[],"lastMainChunkID":0}'
  hypa_v2           TEXT DEFAULT '{}',

  -- Chat.hypaV3Data
  -- HYPA v3 요약 기반 장기 메모리. JSON object.
  -- e.g. '{"summaries":[]}'
  hypa_v3           TEXT DEFAULT '{}',

  -- Chat.scriptstate
  -- 이 세션의 CBS 스크립트 실행 상태. JSON {[key:string]: string|number|boolean}.
  script_state      TEXT DEFAULT '{}',

  -- Chat.localLore
  -- 이 세션에서만 활성화되는 로컬 로어 항목. JSON array.
  local_lore        TEXT DEFAULT '[]',

  -- Chat.folderId
  -- 이 세션이 속한 폴더 ID. ChatFolder.id와 매칭.
  folder_id         TEXT,

  -- Chat.lastDate
  -- 마지막 메시지 시각 (Unix timestamp ms).
  last_date         INTEGER,

  -- Chat.fmIndex
  -- 이 세션에서 사용 중인 firstMessage 인덱스.
  fm_index          INTEGER,

  -- Chat.note
  -- 채팅 세션의 메모. 사용자가 작성하는 자유 텍스트.
  note              TEXT DEFAULT '',

  -- Chat.name
  -- 채팅 세션 이름. e.g. 'Chat 1', 'Chat 2'.
  chat_name         TEXT DEFAULT '',

  -- Chat.id
  -- 채팅 세션 고유 식별자. sync 서버의 chat merge에서 매칭 키로 사용.
  chat_id           TEXT,

  -- Chat.sdData
  -- Stable Diffusion 관련 데이터.
  sd_data           TEXT,

  -- Chat.supaMemoryData
  -- 레거시 장기 메모리 데이터 (Supa Memory).
  supa_memory_data  TEXT,

  -- Chat.lastMemory
  -- 레거시 마지막 메모리 요약 텍스트.
  last_memory       TEXT,

  -- Chat.suggestMessages
  -- AI가 제안한 다음 메시지 목록. JSON string[].
  suggest_messages  TEXT DEFAULT '[]',

  -- Chat.isStreaming
  -- 현재 스트리밍 중인지 여부. 런타임 상태.
  is_streaming      INTEGER DEFAULT 0,

  -- Chat.modules
  -- 이 세션에서 활성화된 모듈 ID 목록. JSON string[].
  modules           TEXT DEFAULT '[]',

  -- Chat.bindedPersona
  -- 이 세션에 바인딩된 페르소나 ID.
  binded_persona    TEXT,

  -- Chat.bookmarks
  -- 북마크된 메시지 ID 배열. JSON string[].
  bookmarks         TEXT DEFAULT '[]',

  -- Chat.bookmarkNames
  -- 북마크 이름 매핑. JSON {[chatId: string]: string}.
  bookmark_names    TEXT DEFAULT '{}',

  -- cold storage 업로드 상태. 'pending' = 미완료, NULL = 완료 또는 불필요.
  -- 재시도 워커가 pending 행을 찾아 chat_messages로부터 페이로드를 재구성하여 업로드.
  __ws_cold_status  TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_character ON chat_sessions(__ws_character_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_uuid ON chat_sessions(uuid);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_deleted ON chat_sessions(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- chat_messages
-- ═══════════════════════════════════════════════════════════════════
-- Source: remotes/{chaId}.local.bin → character.chats[N].message[] 배열
-- 또는 coldstorage/{uuid} → {message: Message[]}
-- 각 메시지는 사용자('user') 또는 캐릭터('char')의 발화 한 턴.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_session_id   TEXT,           -- → chat_sessions.__ws_id. 이 메시지가 속한 세션.
  __ws_display_order INTEGER,       -- message[] 배열 내 인덱스. 표시 순서 복원용.
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- Message.chatId
  -- RisuAI가 부여하는 메시지 고유 ID. optional — 구버전 메시지에는 없을 수 있음.
  chat_id           TEXT,

  -- Message.role
  -- 발화자 역할. 'user' (사용자) 또는 'char' (캐릭터/AI).
  role              TEXT,

  -- Message.data
  -- 메시지 본문 텍스트. 마크다운 형식. CBS/정규식 처리 전 원본.
  data              TEXT DEFAULT '',

  -- Message.saying
  -- 실제 발화 캐릭터의 chaId. 그룹 채팅에서 누가 말했는지 구분.
  saying            TEXT,

  -- Message.name
  -- 표시 이름 오버라이드. 설정 시 캐릭터 이름 대신 이 값 표시.
  name              TEXT,

  -- Message.time
  -- 메시지 생성 시각 (Unix timestamp ms).
  time              INTEGER,

  -- Message.disabled
  -- 비활성 상태. false|true|'allBefore'.
  -- 'allBefore'면 이 메시지 이전 전체를 LLM 컨텍스트에서 제외.
  disabled          TEXT,

  -- Message.isComment
  -- true면 코멘트 메시지 (LLM 컨텍스트에 포함되지 않음).
  is_comment        INTEGER,        -- boolean: 0|1

  -- Message.otherUser
  -- true면 다른 사용자의 메시지 (멀티유저 시나리오).
  other_user        INTEGER,        -- boolean: 0|1

  -- Message.generationInfo
  -- LLM 생성 정보. JSON object.
  -- e.g. '{"model":"gpt-4","inputTokens":1500,"outputTokens":300}'
  generation_info   TEXT DEFAULT '{}',

  -- Message.promptInfo
  -- 프롬프트 프리셋 정보. JSON object.
  -- 이 메시지 생성 시 사용된 프롬프트 설정 스냅샷.
  prompt_info       TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(__ws_session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_deleted ON chat_messages(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- assets
-- ═══════════════════════════════════════════════════════════════════
-- Source: assets/{hash}.{ext}
-- RisuAI는 에셋을 콘텐츠 SHA-256 해시로 저장한다.
-- 동일 파일은 동일 해시 → 자동 중복 제거.
-- with-sqlite는 바이너리를 BLOB으로 보관하여 upstream 삭제 시 복구 가능.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_source_file  TEXT,           -- RisuAI 원본 경로. e.g. 'assets/abc123.png'
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- 콘텐츠 SHA-256 해시. RisuAI의 hasher() 함수로 생성.
  -- 동일 바이너리 → 동일 해시. 중복 검사 및 RisuAI 경로 복원용.
  hash              TEXT,

  -- 에셋 바이너리 데이터 원본.
  data              BLOB,

  -- MIME 타입. e.g. 'image/png', 'image/webp', 'audio/mpeg'
  mime_type         TEXT,

  -- 바이너리 크기 (bytes).
  size              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash);
CREATE INDEX IF NOT EXISTS idx_assets_deleted ON assets(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- character_asset_map
-- ═══════════════════════════════════════════════════════════════════
-- 캐릭터와 에셋의 N:M 매핑.
-- 동일 에셋을 여러 캐릭터가 공유 가능 (콘텐츠 해시 기반 중복 제거).
-- RisuAI 원본 배열 구조 복원에 필요한 메타데이터(label, ext, order)도 보관.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS character_asset_map (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_character_id TEXT,           -- → characters.__ws_id.
  __ws_asset_id     TEXT,           -- → assets.__ws_id.
  __ws_order        INTEGER,        -- 원본 배열 내 인덱스. 순서 복원용.
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- 이 에셋이 참조되는 캐릭터 필드명.
  -- 'image': character.image (메인 캐릭터 이미지, 1개)
  -- 'emotionImages': character.emotionImages 배열 원소
  -- 'additionalAssets': character.additionalAssets 배열 원소
  -- 'ccAssets': character.ccAssets 배열 원소
  field             TEXT,

  -- 에셋의 라벨/이름. field에 따라 의미가 다름:
  -- field='image'            → null (라벨 없음)
  -- field='emotionImages'    → 감정 이름. e.g. 'happy', 'sad', 'angry'
  -- field='additionalAssets' → 에셋 이름. e.g. 'background_01'
  -- field='ccAssets'         → CC 에셋 이름. e.g. 'iconx'
  label             TEXT,

  -- 파일 확장자. RisuAI 원본 배열에 포함된 확장자 정보.
  -- field='additionalAssets' → 튜플의 3번째 값. e.g. 'png', 'mp3'
  -- field='ccAssets'         → object의 ext 필드. e.g. 'png'
  -- 다른 field에서는 null (assets.mime_type에서 유추 가능).
  ext               TEXT,

  -- ccAssets 전용: 에셋 타입. e.g. 'icon', 'background'
  -- field='ccAssets'일 때만 사용. 나머지는 null.
  cc_type           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cam_character ON character_asset_map(__ws_character_id);
CREATE INDEX IF NOT EXISTS idx_cam_asset ON character_asset_map(__ws_asset_id);
CREATE INDEX IF NOT EXISTS idx_cam_deleted ON character_asset_map(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- blocks
-- ═══════════════════════════════════════════════════════════════════
-- Source: database/database.bin (RisuSave 바이너리)
-- RisuSave 포맷: MAGIC("RISUSAVE\\0") + 블록 시퀀스
-- 각 블록: [type:u8][compression:u8][nameLen:u8][name][dataLen:u32LE][data]
--
-- 블록 타입 (RisuSaveType enum):
--   0=CONFIG    글로벌 설정 (온도, 모델, UI 설정 등)
--   1=ROOT      루트 메타데이터 (__directory: 캐릭터 목록 + 순서)
--   4=BOTPRESET 봇 프리셋 설정
--   5=MODULES   모듈 데이터
--   6=REMOTE    캐릭터 포인터 (charId → remotes/{charId}.local.bin)
--   8=ROOT_COMPONENT 루트 컴포넌트
--
-- with-sqlite는 블록을 파싱하여 개별 저장하고,
-- 읽기 시 assembleRisuSave()로 재조립하여 클라이언트에 반환.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_hash         TEXT,           -- 블록 데이터의 SHA-256. reconciliation용 변경 감지.
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- 블록 이름. RisuSave 바이너리 내의 블록 식별자.
  -- e.g. 'config_0', 'root_0', 'botpreset_0', 'modules_0', 'remote:char-abc'
  name              TEXT,

  -- RisuSaveType enum 값.
  -- 0=CONFIG, 1=ROOT, 4=BOTPRESET, 5=MODULES, 6=REMOTE, 8=ROOT_COMPONENT
  type              INTEGER,

  -- 블록 출처 파일. 현재는 항상 'database.bin'.
  source            TEXT,

  -- 블록 데이터. plain TEXT (JSON).
  -- 파싱 시 gzip 압축이 해제된 상태로 저장.
  data              TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocks_name ON blocks(name);
CREATE INDEX IF NOT EXISTS idx_blocks_source ON blocks(source);
CREATE INDEX IF NOT EXISTS idx_blocks_deleted ON blocks(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- file_list_cache
-- ═══════════════════════════════════════════════════════════════════
-- Source: GET /api/list 응답 + remotes/{charId}.meta 파일
-- RisuAI 파일 시스템의 전체 파일 목록과 .meta 파일의 lastUsed 타임스탬프.
-- 클라이언트 초기 로딩 최적화: 전체 파일 목록을 캐싱하여
-- /api/list 요청을 DB에서 즉시 응답.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_list_cache (
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_updated_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  __ws_deleted_at   TIMESTAMP,

  -- RisuAI 파일 경로. e.g. 'remotes/abc-123.local.bin', 'assets/def456.png'
  path              TEXT,

  -- .meta 파일의 lastUsed 타임스탬프 (Unix timestamp ms).
  -- 캐릭터 최근 사용일 표시 및 정렬에 사용.
  -- .meta가 아닌 파일은 null.
  last_used         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_file_list_path ON file_list_cache(path);
CREATE INDEX IF NOT EXISTS idx_file_list_deleted ON file_list_cache(__ws_deleted_at);


-- ═══════════════════════════════════════════════════════════════════
-- schema_version (마이그레이션 추적)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schema_version (
  version   INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

`;
