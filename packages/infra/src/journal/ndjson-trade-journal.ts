import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { JournalEvent, TradeJournalPort } from '@bot/core/domain/order';

/**
 * Durable NDJSON audit trail for live-style execution.
 *
 * One event per line, appended synchronously — the write hits the file before
 * the adapter's method returns, so a crash can lose at most the line being
 * written at that instant. On read, a torn FINAL line (the signature of a
 * kill mid-write) is dropped with a warning; a malformed line anywhere else
 * means the file was edited or corrupted, and that is an error.
 *
 * Non-finite numbers are rejected on append for the same reason the candle
 * cache rejects them: `JSON.stringify(NaN)` is `null`, and a silent null in
 * an audit trail is worse than a crash.
 */
export class NdjsonTradeJournal implements TradeJournalPort {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: JournalEvent): void {
    assertFiniteNumbers(event, 'journal event');
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  readAll(): JournalEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }

    const lines = readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    const events: JournalEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]) as JournalEvent);
      } catch {
        if (i === lines.length - 1) {
          console.warn(
            `${this.path}: dropping a torn final line (crash mid-write); ` +
              'state resumes from the previous event',
          );
          break;
        }
        throw new Error(`${this.path}: corrupt journal at line ${i + 1}`);
      }
    }
    return events;
  }
}

function assertFiniteNumbers(value: unknown, where: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Refusing a non-finite number in ${where}: ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertFiniteNumbers(item, where);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      assertFiniteNumbers(item, where);
    }
  }
}
