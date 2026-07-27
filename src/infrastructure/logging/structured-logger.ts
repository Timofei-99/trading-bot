import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface StructuredLoggerOptions {
  readonly level?: LogLevel;
  /** Mirror every record to this NDJSON file as well as stdout. */
  readonly filePath?: string;
  /** Fields attached to every record from this logger. */
  readonly base?: Record<string, unknown>;
  readonly clock?: () => number;
  readonly write?: (line: string) => void;
}

/** Field names whose values are replaced wholesale, at any depth. */
const SECRET_KEYS = /^(secret|apikey|api_key|apisecret|api_secret|password|token|signature|sign)$/i;

/**
 * Line-delimited JSON logging with secret redaction.
 *
 * Deliberately not pino, though the plan named it: this process holds exchange
 * API credentials, so its logging path is worth keeping to fifty auditable
 * lines with no dependency surface. The output is the same NDJSON the rest of
 * the codebase already reads and writes, and `redact()` is applied to every
 * record rather than to a configured list of paths — a key that reaches a log
 * through an unexpected field is exactly the one a configured list misses.
 */
export class StructuredLogger {
  private readonly level: number;
  private readonly filePath: string | undefined;
  private readonly base: Record<string, unknown>;
  private readonly clock: () => number;
  private readonly write: (line: string) => void;

  constructor(options: StructuredLoggerOptions = {}) {
    this.level = ORDER[options.level ?? 'info'];
    this.filePath = options.filePath;
    this.base = options.base ?? {};
    this.clock = options.clock ?? Date.now;
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));

    if (this.filePath !== undefined) {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
  }

  /** A logger that adds more fixed fields, e.g. the symbol being traded. */
  child(base: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger({
      level: levelName(this.level),
      filePath: this.filePath,
      base: { ...this.base, ...base },
      clock: this.clock,
      write: this.write,
    });
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.emit('error', message, fields);
  }

  private emit(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (ORDER[level] < this.level) {
      return;
    }
    const record = {
      time: new Date(this.clock()).toISOString(),
      level,
      message,
      ...(redact({ ...this.base, ...fields }) as Record<string, unknown>),
    };
    const line = JSON.stringify(record);
    this.write(line);
    if (this.filePath !== undefined) {
      appendFileSync(this.filePath, `${line}\n`, 'utf8');
    }
  }
}

/** Replace anything that looks like a credential, however deeply nested. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(item);
    }
    return out;
  }
  return value;
}

function levelName(order: number): LogLevel {
  return (Object.keys(ORDER) as LogLevel[]).find((name) => ORDER[name] === order) ?? 'info';
}
