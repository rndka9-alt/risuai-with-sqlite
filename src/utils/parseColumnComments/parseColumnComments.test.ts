import { describe, it, expect } from 'vitest';
import { parseColumnComments } from './parseColumnComments';

describe('parseColumnComments', () => {
  it('extracts above-column comments', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- 캐릭터 고유 식별자. RisuAI가 생성하는 UUID.
  char_id TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.get('char_id')).toBe('캐릭터 고유 식별자. RisuAI가 생성하는 UUID.');
  });

  it('extracts multi-line above-column comments', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- character.chaId / groupChat.chaId
  -- 캐릭터 고유 식별자.
  char_id TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.get('char_id')).toBe('character.chaId / groupChat.chaId\n캐릭터 고유 식별자.');
  });

  it('extracts inline comments', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  __ws_hash TEXT,           -- 원본 JSON 전체의 SHA-256
  name TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.get('__ws_hash')).toBe('원본 JSON 전체의 SHA-256');
    expect(map.has('name')).toBe(false);
  });

  it('combines above and inline comments', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- 유틸리티 봇 여부
  utility_bot INTEGER,        -- boolean: 0|1
  name TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.get('utility_bot')).toBe('유틸리티 봇 여부\nboolean: 0|1');
  });

  it('skips section headers with box-drawing chars', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- ── with-sqlite 관리 ──────────────────────────────────────────
  __ws_id TEXT,
  -- ═══════════════════════════════════════════════════════════════════
  -- 캐릭터 이름
  name TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.has('__ws_id')).toBe(false);
    expect(map.get('name')).toBe('캐릭터 이름');
  });

  it('resets buffer on empty lines', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- 이 주석은 아래 컬럼에 해당하지 않음

  name TEXT
)`;
    const map = parseColumnComments(ddl);
    expect(map.has('name')).toBe(false);
  });

  it('handles quoted column names', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS t (
  -- 캐릭터 설명
  "desc" TEXT DEFAULT ''
)`;
    const map = parseColumnComments(ddl);
    expect(map.get('desc')).toBe('캐릭터 설명');
  });

  it('returns empty map for DDL without comments', () => {
    const ddl = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`;
    const map = parseColumnComments(ddl);
    expect(map.size).toBe(0);
  });

  it('handles real-world characters table excerpt', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS characters (
  -- ── with-sqlite 관리 ──────────────────────────────────────────
  __ws_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  __ws_hash         TEXT,           -- 원본 JSON 전체의 SHA-256. 변경 감지 및 reconciliation용
  __ws_source_file  TEXT,           -- RisuAI 원본 파일 경로. e.g. 'remotes/abc-123.local.bin'
  __ws_created_at   TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- ── 기본 메타데이터 ───────────────────────────────────────────
  -- character.chaId / groupChat.chaId
  -- 캐릭터 고유 식별자. RisuAI가 생성하는 UUID.
  char_id           TEXT,

  -- character.name / groupChat.name
  -- 캐릭터 표시 이름.
  name              TEXT DEFAULT ''
)`;
    const map = parseColumnComments(ddl);
    expect(map.has('__ws_id')).toBe(false);
    expect(map.get('__ws_hash')).toBe('원본 JSON 전체의 SHA-256. 변경 감지 및 reconciliation용');
    expect(map.get('__ws_source_file')).toBe("RisuAI 원본 파일 경로. e.g. 'remotes/abc-123.local.bin'");
    expect(map.has('__ws_created_at')).toBe(false);
    expect(map.get('char_id')).toBe('character.chaId / groupChat.chaId\n캐릭터 고유 식별자. RisuAI가 생성하는 UUID.');
    expect(map.get('name')).toBe('character.name / groupChat.name\n캐릭터 표시 이름.');
  });
});
