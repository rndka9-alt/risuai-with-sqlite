import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _clientJs: string | null = null;

export function getClientJs(): string {
  if (!_clientJs) {
    const bundlePath = path.join(__dirname, 'client.js');
    try {
      _clientJs = fs.readFileSync(bundlePath, 'utf-8');
    } catch {
      _clientJs = '// db-proxy client bundle not found';
    }
  }
  return _clientJs;
}

/**
 * Inject our client script tag into HTML response.
 * Inserts `<script defer src="/db/client.js"></script>` before </head>.
 */
export function injectScriptTag(html: string): string {
  const tag = '<script defer src="/db/client.js"></script>';
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return html.slice(0, headClose) + tag + html.slice(headClose);
  }
  // Fallback: append to end
  return html + tag;
}
