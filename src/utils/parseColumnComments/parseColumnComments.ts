/**
 * sqlite_master.sql에 보존된 DDL 주석을 파싱하여
 * 컬럼명 → 설명 매핑을 반환한다.
 *
 * SQLite는 CREATE TABLE 원문을 sqlite_master.sql에 주석 포함으로 보존한다.
 * 이를 이용해 컬럼 바로 위에 작성된 `--` 주석과 인라인 주석을 추출한다.
 */
export function parseColumnComments(ddlSql: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = ddlSql.split('\n');
  const buffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 섹션 구분선(═, ─ 포함)은 컬럼 설명이 아니므로 버퍼 리셋
    if (trimmed.startsWith('--') && /[═─]/.test(trimmed)) {
      buffer.length = 0;
      continue;
    }

    // 주석 라인 축적
    if (trimmed.startsWith('--')) {
      const text = trimmed.slice(2).trim();
      if (text) {
        buffer.push(text);
      }
      continue;
    }

    // 빈 줄, CREATE TABLE, 닫는 괄호 — 버퍼 리셋
    if (!trimmed || /^(CREATE\s+TABLE|[)];?$)/i.test(trimmed)) {
      buffer.length = 0;
      continue;
    }

    // CREATE INDEX 등 비-컬럼 구문 — 버퍼 리셋
    if (/^(CREATE\s+INDEX|INSERT|SELECT|DROP|ALTER)\b/i.test(trimmed)) {
      buffer.length = 0;
      continue;
    }

    // 컬럼 정의 라인에서 컬럼명 추출
    const colMatch = trimmed.match(/^"?(\w+)"?\s/);
    if (!colMatch) {
      buffer.length = 0;
      continue;
    }

    const colName = colMatch[1];

    // 인라인 주석 추출 (컬럼 정의 뒤의 -- 주석)
    const inlineMatch = trimmed.match(/,?\s+--\s+(.+)$/);
    if (inlineMatch) {
      buffer.push(inlineMatch[1]);
    }

    if (buffer.length > 0) {
      result.set(colName, buffer.join('\n'));
    }

    buffer.length = 0;
  }

  return result;
}
