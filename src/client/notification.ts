/**
 * Simple notification UI for stream recovery events.
 */

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container) return container;

  container = document.createElement('div');
  container.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
  document.body.appendChild(container);
  return container;
}

export function showNotification(message: string, type: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText =
    `padding:12px 20px;border-radius:8px;font-size:14px;pointer-events:auto;cursor:pointer;` +
    `box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:360px;word-break:break-word;` +
    `transition:opacity 0.3s;` +
    (type === 'error'
      ? 'background:#c0392b;color:#fff;'
      : 'background:#2c3e50;color:#ecf0f1;');

  el.addEventListener('click', () => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  });

  ensureContainer().appendChild(el);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 5000);
}
