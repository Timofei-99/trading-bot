import { MissingTokenError, OandaCandle, parseArgs, toMt5Row } from './download-ger40-oanda';

const NOW = new Date('2024-06-15T13:47:12.000Z');

describe('parseArgs', () => {
  it('requires a token', () => {
    expect(() => parseArgs([], NOW)).toThrow(MissingTokenError);
  });

  it('accepts the token under either flag', () => {
    expect(parseArgs(['--token', 'abc'], NOW).token).toBe('abc');
    expect(parseArgs(['-t', 'abc'], NOW).token).toBe('abc');
  });

  it('defaults to the practice endpoint', () => {
    expect(parseArgs(['-t', 'abc'], NOW).baseUrl).toBe('https://api-fxpractice.oanda.com');
  });

  it('switches to the live endpoint only when asked', () => {
    expect(parseArgs(['-t', 'abc', '--live'], NOW).baseUrl).toBe('https://api-fxtrade.oanda.com');
  });

  it('defaults the instrument to OANDA name for the DAX', () => {
    expect(parseArgs(['-t', 'abc'], NOW).instrument).toBe('DE30_EUR');
    expect(parseArgs(['-t', 'abc', '--instrument', 'DE40_EUR'], NOW).instrument).toBe('DE40_EUR');
  });

  it('defaults --to to the current UTC midnight, not the current instant', () => {
    expect(parseArgs(['-t', 'abc'], NOW).to.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('defaults --from to two years before --to, not before today', () => {
    // Anchoring the default span on today would silently widen a window the
    // caller bounded with an explicit --to.
    const args = parseArgs(['-t', 'abc', '--to', '2020-03-01'], NOW);

    expect(args.to.toISOString()).toBe('2020-03-01T00:00:00.000Z');
    expect(args.from.toISOString()).toBe('2018-03-01T00:00:00.000Z');
  });

  it('takes both bounds when given', () => {
    const args = parseArgs(['-t', 'abc', '--from', '2023-01-01', '--to', '2024-12-31'], NOW);

    expect(args.from.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    expect(args.to.toISOString()).toBe('2024-12-31T00:00:00.000Z');
  });

  it('ignores a flag whose value is missing rather than consuming the next flag', () => {
    // `--instrument` with nothing after it must not swallow `--live`.
    const args = parseArgs(['-t', 'abc', '--live', '--instrument'], NOW);

    expect(args.instrument).toBe('DE30_EUR');
    expect(args.baseUrl).toContain('fxtrade');
  });
});

describe('toMt5Row', () => {
  const candle = (over: Partial<OandaCandle> = {}): OandaCandle => ({
    time: '2024-01-15T09:05:00.000000000Z',
    mid: { o: '18000.44', h: '18010.55', l: '17990.11', c: '18005.99' },
    volume: 137,
    complete: true,
    ...over,
  });

  it('writes a tab-separated MT5 row with UTC date and time', () => {
    expect(toMt5Row(candle()).split('\t')).toEqual([
      '2024.01.15',
      '09:05:00',
      '18000.4',
      '18010.5',
      '17990.1',
      '18006.0',
      '137',
      '0',
      '0',
    ]);
  });

  it('parses OANDA nanosecond timestamps', () => {
    const row = toMt5Row(candle({ time: '2023-12-31T23:59:00.123456789Z' }));

    expect(row.startsWith('2023.12.31\t23:59:00\t')).toBe(true);
  });
});
