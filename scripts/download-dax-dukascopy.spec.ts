import {
  Bar,
  eachDay,
  parseTicks,
  Tick,
  toMinuteBars,
  toMt5Row,
  utcMidnight,
} from './download-dax-dukascopy';

const HOUR = Date.UTC(2024, 0, 15, 9); // 2024-01-15T09:00:00Z

/** One 20-byte Dukascopy tick record: big-endian, prices scaled by 10. */
function tickRecord(msOffset: number, ask: number, bid: number, askVol: number, bidVol: number) {
  const buf = Buffer.alloc(20);
  buf.writeUInt32BE(msOffset, 0);
  buf.writeUInt32BE(Math.round(ask * 10), 4);
  buf.writeUInt32BE(Math.round(bid * 10), 8);
  buf.writeFloatBE(askVol, 12);
  buf.writeFloatBE(bidVol, 16);
  return buf;
}

describe('parseTicks', () => {
  it('decodes price, volume and timestamp from a tick record', () => {
    const ticks = parseTicks(tickRecord(1_500, 18_000.4, 18_000.0, 0.5, 0.25), HOUR);

    expect(ticks).toHaveLength(1);
    expect(ticks[0].ms).toBe(HOUR + 1_500);
    // mid of ask 18000.4 and bid 18000.0
    expect(ticks[0].mid).toBeCloseTo(18_000.2, 6);
    expect(ticks[0].vol).toBeCloseTo(0.75, 6);
  });

  it('reads every record in a multi-tick buffer', () => {
    const raw = Buffer.concat([
      tickRecord(0, 100, 100, 1, 1),
      tickRecord(1_000, 200, 200, 1, 1),
      tickRecord(2_000, 300, 300, 1, 1),
    ]);

    expect(parseTicks(raw, HOUR).map((tick) => tick.ms)).toEqual([
      HOUR,
      HOUR + 1_000,
      HOUR + 2_000,
    ]);
  });

  it('ignores a trailing partial record rather than throwing', () => {
    // The feed occasionally serves a truncated hour; losing its last tick is
    // cheaper than losing the whole day to an exception.
    const raw = Buffer.concat([tickRecord(0, 100, 100, 1, 1), Buffer.alloc(9)]);

    expect(parseTicks(raw, HOUR)).toHaveLength(1);
  });

  it('returns nothing for an empty buffer', () => {
    expect(parseTicks(Buffer.alloc(0), HOUR)).toEqual([]);
  });
});

describe('toMinuteBars', () => {
  const tick = (ms: number, mid: number, vol = 1): Tick => ({ ms, mid, vol });

  it('folds ticks in the same minute into one bar', () => {
    const bars = toMinuteBars([
      tick(HOUR + 1_000, 100),
      tick(HOUR + 2_000, 105),
      tick(HOUR + 3_000, 95),
      tick(HOUR + 4_000, 102),
    ]);

    expect(bars).toEqual<Bar[]>([
      { ms: HOUR, open: 100, high: 105, low: 95, close: 102, volume: 4 },
    ]);
  });

  it('splits ticks across minute boundaries', () => {
    const bars = toMinuteBars([tick(HOUR + 59_999, 100), tick(HOUR + 60_000, 200)]);

    expect(bars.map((bar) => bar.ms)).toEqual([HOUR, HOUR + 60_000]);
    expect(bars.map((bar) => bar.open)).toEqual([100, 200]);
  });

  it('returns bars in chronological order', () => {
    // Bars are sorted even though the minutes were first seen out of order.
    const bars = toMinuteBars([tick(HOUR + 120_000, 300), tick(HOUR, 100)]);

    expect(bars.map((bar) => bar.ms)).toEqual([HOUR, HOUR + 120_000]);
  });

  it('takes open and close from input order, which the caller must keep sorted', () => {
    // Documents the contract rather than a bug: sorting bars afterwards cannot
    // repair an open/close taken from out-of-order ticks, so the requirement
    // is on the caller. `main` feeds ticks hour by hour, in order.
    const bars = toMinuteBars([tick(HOUR + 30_000, 100), tick(HOUR + 10_000, 200)]);

    expect(bars[0].open).toBe(100);
    expect(bars[0].close).toBe(200);
  });

  it('has nothing to fold when there are no ticks', () => {
    expect(toMinuteBars([])).toEqual([]);
  });
});

describe('toMt5Row', () => {
  it('writes a tab-separated MT5 row with UTC date and time', () => {
    const row = toMt5Row({
      ms: Date.UTC(2024, 0, 15, 9, 5),
      open: 18_000.44,
      high: 18_010.55,
      low: 17_990.11,
      close: 18_005.99,
      volume: 12.7,
    });

    expect(row.split('\t')).toEqual([
      '2024.01.15',
      '09:05:00',
      '18000.4',
      '18010.5',
      '17990.1',
      '18006.0',
      '13',
      '0',
      '0',
    ]);
  });

  it('rounds prices the way toFixed does, not half-up', () => {
    // 18010.55 is held as 18010.5499…, so it rounds DOWN. Worth pinning: the
    // CSV is an input to backtests, and a silent change of rounding here would
    // move fills by a tick without anything else looking different.
    const row = toMt5Row({
      ms: Date.UTC(2024, 0, 15, 9, 5),
      open: 18_010.55,
      high: 18_010.65,
      low: 0.25,
      close: 0.35,
      volume: 0,
    });

    // 18010.55 → down, 18010.65 → up, 0.25 → up, 0.35 → down: the direction
    // follows the binary value, not the decimal that was written.
    expect(row.split('\t').slice(2, 6)).toEqual(['18010.5', '18010.7', '0.3', '0.3']);
  });
});

describe('date helpers', () => {
  it('reads a date as UTC midnight', () => {
    expect(utcMidnight('2024-01-15').toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('rejects a date it cannot parse', () => {
    expect(() => utcMidnight('not-a-date')).toThrow(/Invalid date/);
  });

  it('enumerates days inclusive of both ends', () => {
    const days = eachDay(utcMidnight('2024-01-15'), utcMidnight('2024-01-17'));

    expect(days.map((day) => day.toISOString().slice(0, 10))).toEqual([
      '2024-01-15',
      '2024-01-16',
      '2024-01-17',
    ]);
  });

  it('crosses a DST boundary without dropping or repeating a day', () => {
    // Europe switches on 2024-03-31; the walk is UTC-based, so it must not care.
    const days = eachDay(utcMidnight('2024-03-30'), utcMidnight('2024-04-01'));

    expect(days.map((day) => day.toISOString().slice(0, 10))).toEqual([
      '2024-03-30',
      '2024-03-31',
      '2024-04-01',
    ]);
  });

  it('yields a single day when both ends are the same', () => {
    expect(eachDay(utcMidnight('2024-01-15'), utcMidnight('2024-01-15'))).toHaveLength(1);
  });

  it('yields nothing when the range runs backwards', () => {
    expect(eachDay(utcMidnight('2024-01-17'), utcMidnight('2024-01-15'))).toEqual([]);
  });
});
