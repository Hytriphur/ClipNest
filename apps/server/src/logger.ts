export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(raw?: string | null): LogLevel | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return null;
}

const CURRENT_LEVEL: LogLevel = normalizeLevel(process.env.XIC_LOG_LEVEL) ?? 'info';

function canLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[CURRENT_LEVEL];
}

function safeStringify(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  if (!meta || Object.keys(meta).length === 0) return `${ts} [${level}] ${message}`;
  return `${ts} [${level}] ${message} ${safeStringify(meta)}`;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (!canLog(level)) return;
  const line = formatLine(level, message, meta);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

export const logger = {
  level: CURRENT_LEVEL,
  debug(message: string, meta?: Record<string, unknown>) {
    write('debug', message, meta);
  },
  info(message: string, meta?: Record<string, unknown>) {
    write('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    write('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    write('error', message, meta);
  },
};

export function isDebugEnabled() {
  return canLog('debug');
}
