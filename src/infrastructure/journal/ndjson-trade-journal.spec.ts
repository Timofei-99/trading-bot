import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JournalEvent } from '../../domain/order';
import { NdjsonTradeJournal } from './ndjson-trade-journal';

const session = (balance: number): JournalEvent => ({
  type: 'session',
  at: Date.UTC(2024, 0, 1),
  note: 'start',
  balance,
});

describe('NdjsonTradeJournal', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-'));
    path = join(dir, 'nested', 'paper.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips events in order', () => {
    const journal = new NdjsonTradeJournal(path);
    journal.append(session(10_000));
    journal.append({
      type: 'entry_settled',
      at: 1,
      orderId: 'a',
      symbol: 'BTC/USDT',
      status: 'filled',
      fillPrice: 98,
      fillTime: 1,
    });

    expect(new NdjsonTradeJournal(path).readAll()).toEqual([
      session(10_000),
      expect.objectContaining({ type: 'entry_settled', orderId: 'a' }),
    ]);
  });

  it('reads an absent file as an empty journal', () => {
    expect(new NdjsonTradeJournal(path).readAll()).toEqual([]);
  });

  it('drops a torn final line — the signature of a crash mid-write', () => {
    const journal = new NdjsonTradeJournal(path);
    journal.append(session(10_000));
    appendFileSync(path, '{"type":"position_clo', 'utf8'); // kill -9 here

    const events = journal.readAll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session');
  });

  it('treats a malformed line in the middle as corruption', () => {
    const journal = new NdjsonTradeJournal(path);
    journal.append(session(10_000));
    appendFileSync(path, 'garbage\n', 'utf8');
    journal.append(session(9_000));

    expect(() => journal.readAll()).toThrow(/corrupt journal at line 2/);
  });

  it('refuses a non-finite number anywhere in an event', () => {
    const journal = new NdjsonTradeJournal(path);
    expect(() => journal.append(session(Number.NaN))).toThrow(/non-finite/);
    expect(() =>
      journal.append({
        type: 'position_closed',
        at: 1,
        orderId: 'a',
        symbol: 'X',
        exitPrice: Number.POSITIVE_INFINITY,
        exitTime: 1,
        exitReason: 'tp',
        pnlPct: 0,
        balance: 1,
      }),
    ).toThrow(/non-finite/);
    expect(existsSync(path)).toBe(false); // nothing was ever persisted
  });
});
