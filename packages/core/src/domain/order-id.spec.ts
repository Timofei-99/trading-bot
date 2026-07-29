import { entryOrderId, exitOrderId } from './order-id';
import { Direction, Signal } from './signal';

const BAR = Date.UTC(2024, 0, 15, 9);

const signal = (over: Partial<ConstructorParameters<typeof Signal>[0]> = {}): Signal =>
  new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry: 42_000,
    stopLoss: 41_000,
    takeProfit: 44_000,
    timeframe: '15m',
    timestamp: BAR,
    strategyName: 'OB_4h_FVG_15m',
    strategyVersion: '1.0',
    ...over,
  });

describe('entryOrderId', () => {
  it('is stable for the same signal', () => {
    // The property everything else rests on: a restart that recomputes the
    // same decision must produce the same key, so the venue can reject it.
    expect(entryOrderId(signal())).toBe(entryOrderId(signal()));
  });

  it('survives a round trip through the journal', () => {
    // Restore rebuilds the Signal from JSON; the id must not depend on object
    // identity or on fields that do not survive serialisation.
    const original = signal();
    const revived = new Signal(JSON.parse(JSON.stringify(original)) as never);

    expect(entryOrderId(revived)).toBe(entryOrderId(original));
  });

  describe('changes when the decision changes', () => {
    it.each([
      ['bar', { timestamp: BAR + 900_000 }],
      ['symbol', { symbol: 'ETH/USDT' }],
      ['direction', { direction: Direction.Short }],
      ['strategy', { strategyName: 'frankfurt_ib_50' }],
      ['strategy version', { strategyVersion: '2.0' }],
    ])('differs on a different %s', (_name, over) => {
      expect(entryOrderId(signal(over))).not.toBe(entryOrderId(signal()));
    });
  });

  describe('does not change when only the levels move', () => {
    // A restart may recompute a signal whose stop sits a tick away because a
    // detector saw one more bar of history. That is the same trading decision
    // and must collide, not open a second position.
    it.each([
      ['entry', { entry: 42_000.5 }],
      ['stop', { stopLoss: 40_999 }],
      ['target', { takeProfit: 44_001 }],
    ])('is unchanged by a different %s', (_name, over) => {
      expect(entryOrderId(signal(over))).toBe(entryOrderId(signal()));
    });
  });

  describe('venue constraints', () => {
    it('fits inside Bybit orderLinkId, which is capped at 36 characters', () => {
      expect(entryOrderId(signal()).length).toBeLessThanOrEqual(36);
    });

    it('uses only characters a venue will accept', () => {
      // Symbols contain a slash and strategy names contain underscores; the id
      // must not carry either through verbatim.
      expect(entryOrderId(signal())).toMatch(/^bot-[0-9a-f]{8}$/);
    });

    it('stays clean for a symbol full of awkward characters', () => {
      expect(entryOrderId(signal({ symbol: 'BTC/USDT:USDT-PERP' }))).toMatch(/^bot-[0-9a-f]{8}$/);
    });
  });

  it('separates fields so adjacent values cannot be confused', () => {
    // Without a separator, ("ab", "c") and ("a", "bc") would hash identically
    // and two different strategies could collide on the same bar.
    const a = entryOrderId(signal({ strategyName: 'ab', strategyVersion: 'c' }));
    const b = entryOrderId(signal({ strategyName: 'a', strategyVersion: 'bc' }));

    expect(a).not.toBe(b);
  });
});

describe('exitOrderId', () => {
  it('is stable for the same position', () => {
    const entry = entryOrderId(signal());

    expect(exitOrderId(entry)).toBe(exitOrderId(entry));
  });

  it('differs from the entry it closes', () => {
    // A close must not collide with its own open, or the venue rejects the
    // exit as a duplicate of the entry and the position never closes.
    const entry = entryOrderId(signal());

    expect(exitOrderId(entry)).not.toBe(entry);
  });

  it('differs for different positions', () => {
    expect(exitOrderId(entryOrderId(signal()))).not.toBe(
      exitOrderId(entryOrderId(signal({ timestamp: BAR + 900_000 }))),
    );
  });

  it('still fits inside Bybit orderLinkId', () => {
    expect(exitOrderId(entryOrderId(signal())).length).toBeLessThanOrEqual(36);
  });
});
