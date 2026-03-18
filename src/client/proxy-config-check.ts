/**
 * Check /.proxy/config on init and show a toast if usePlainFetch is enabled.
 * Uses sessionStorage to ensure the toast is shown at most once per session.
 */

import { showNotification } from './notification';

const SESSION_KEY = 'risu-proxy-config-notified';

interface ProxyConfigEntry {
  usePlainFetch?: boolean | null;
  [key: string]: unknown;
}

interface ProxyConfig {
  withSqlite?: ProxyConfigEntry;
  sync?: ProxyConfigEntry;
  [key: string]: unknown;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  return typeof value === 'object' && value !== null;
}

export function checkProxyConfig(): void {
  if (sessionStorage.getItem(SESSION_KEY)) return;

  fetch('/.proxy/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((raw: unknown) => {
      if (!isProxyConfig(raw)) return;

      const plainFetch =
        raw.withSqlite?.usePlainFetch === true ||
        raw.sync?.usePlainFetch === true;
      if (!plainFetch) return;

      const features: string[] = [];
      if (raw.withSqlite) features.push('스트리밍 복구');
      if (raw.sync) features.push('실시간 공유');

      if (features.length > 0) {
        sessionStorage.setItem(SESSION_KEY, '1');
        showNotification(
          `직접 요청 모드 — ${features.join(', ')} 꺼짐`,
        );
      }
    })
    .catch(() => {
      // Best-effort; never block normal operation
    });
}
