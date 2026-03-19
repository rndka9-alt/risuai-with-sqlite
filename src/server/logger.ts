import { LOG_LEVEL } from './config';

const LEVEL_ORDER: { [key: string]: number | undefined } = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LEVEL_ORDER[LOG_LEVEL] ?? 1;

function formatData(data: { [key: string]: unknown }): string {
  const lines: string[] = [];
  for (const key of Object.keys(data)) {
    const val = typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]);
    lines.push(`  ${key}: ${val}`);
  }
  return lines.join('\n');
}

function log(level: string, levelNum: number, message: string, data?: { [key: string]: unknown }): void {
  if (levelNum < currentLevel) return;
  const tag = `[DB-Proxy] [${level.toUpperCase()}]`;
  const line = `${tag} ${message}`;
  if (levelNum >= 2) {
    console.error(data ? `${line}\n${formatData(data)}` : line);
  } else {
    console.log(data ? `${line}\n${formatData(data)}` : line);
  }
}

export function debug(message: string, data?: { [key: string]: unknown }): void {
  log('debug', 0, message, data);
}

export function info(message: string, data?: { [key: string]: unknown }): void {
  log('info', 1, message, data);
}

export function warn(message: string, data?: { [key: string]: unknown }): void {
  log('warn', 2, message, data);
}

export function error(message: string, data?: { [key: string]: unknown }): void {
  log('error', 3, message, data);
}
