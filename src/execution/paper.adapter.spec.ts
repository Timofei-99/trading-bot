import { Candle } from '../domain/candle-series';
import { JournalEvent, TradeJournalPort } from '../domain/order';
import { Direction, Signal } from '../domain/signal';
import { PaperAdapter } from './paper.adapter';

const SYMBOL = 'BTC/USDT';
const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number): number => T0 + i * M15;

function candle(i: number, high: number, low: number, close?: number): Candle {
  const mid = close ?? (high + low) / 2;
  return { time: bar(i), open: mid, high, low, close: mid, volume: 1000 };
}

function makeSignal(
  entry = 98,
  stopLoss = 95,
  takeProfit = 104,
  expiryTime: number | null = null,
): Signal {
  return new Signal({
    symbol: SYMBOL,
    direction: Direction.Long,
    entry,
    stopLoss,
    takeProfit,
    timeframe: '15m',
    timestamp: bar(0),
    strategyName: 'test',
    strategyVersion: '1',
    expiryTime,
  });
}

/** In-memory journal double. */
class MemoryJournal implements TradeJournalPort {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  readAll(): JournalEvent[] {
    return [...this.events];
  }
}

describe('PaperAdapter', () => {
  describe('placing an entry', () => {
    it('rests the order instead of opening a position', async () => {
      const adapter = new PaperAdapter();
      const order = await adapter.placeEntry(makeSignal());

      expect(order.status).toBe('open');
      expect(await adapter.getRestingEntry(SYMBOL)).toBe(order);
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });

    it('refuses a second engagement on the same symbol', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal());
      await expect(adapter.placeEntry(makeSignal())).rejects.toThrow(/Already engaged/);
    });

    it('caps the position by what the wallet can buy, fees included', async () => {
      // Risk sizing alone would ask for 10000*0.01/0.1 = 1000 units of a
      // 100-priced asset — a 100k notional on a 10k wallet.
      const adapter = new PaperAdapter({ initialBalance: 10_000, riskPerTrade: 0.01, feeRate: 0.001 });
      const order = await adapter.placeEntry(makeSignal(100, 99.9, 104));

      expect(order.positionSize).toBeCloseTo(10_000 / (100 * 1.001), 9);
      expect(order.positionSize * 100).toBeLessThanOrEqual(10_000);
    });
  });

  describe('entry settlement on closed bars', () => {
    it('never fills on the signal bar itself', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal(98));
      // Same timestamp as placement: the touch predates the order.
      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(0, 100, 97) });

      expect(result.settledEntries).toHaveLength(0);
      expect(await adapter.getRestingEntry(SYMBOL)).not.toBeNull();
    });

    it('fills at the limit price when a later bar touches it', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal(98));
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 99) }); // no touch

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 100, 97.5) });

      expect(result.settledEntries[0]?.status).toBe('filled');
      expect(result.settledEntries[0]?.fillPrice).toBe(98);
      const position = await adapter.getPosition(SYMBOL);
      expect(position?.entryPrice).toBe(98);
      expect(position?.entryTime).toBe(bar(2));
    });

    it('expires an unfilled entry after the timeout', async () => {
      const adapter = new PaperAdapter({ entryTimeoutMs: 2 * M15 });
      await adapter.placeEntry(makeSignal(98));

      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 99) });
      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });

      expect(result.settledEntries[0]?.status).toBe('expired');
      expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });

    it('can fill and take profit on the same bar, like the backtest', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal(98, 95, 100));

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 97.5) });

      expect(result.settledEntries[0]?.status).toBe('filled');
      expect(result.closed).toHaveLength(1);
      expect(result.closed[0].exitReason).toBe('tp');
    });

    it('cancelEntry removes the resting order', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal());
      const cancelled = await adapter.cancelEntry(SYMBOL);

      expect(cancelled?.status).toBe('cancelled');
      expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
      expect(await adapter.cancelEntry(SYMBOL)).toBeNull();
    });
  });

  describe('position settlement mirrors the backtest rules', () => {
    async function opened(options = {}): Promise<PaperAdapter> {
      const adapter = new PaperAdapter(options);
      await adapter.placeEntry(makeSignal(98, 95, 104));
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 99, 97.5) }); // fill, no exit
      return adapter;
    }

    it('closes at TP with fees netted into the trade', async () => {
      const adapter = await opened({ feeRate: 0.001 });
      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 104.5, 99) });

      const trade = result.closed[0];
      expect(trade.exitReason).toBe('tp');
      const gross = (104 - 98) / 98;
      expect(trade.pnlPct).toBeCloseTo(gross - 0.001 * (1 + 104 / 98), 12);
    });

    it('slips a stop-loss fill', async () => {
      const adapter = await opened({ slippage: 0.001 });
      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 99, 94) });

      expect(result.closed[0].exitReason).toBe('sl');
      expect(result.closed[0].exitPrice).toBeCloseTo(95 * 0.999, 12);
    });

    it('honours worst-case resolution on a bar spanning both levels', async () => {
      const adapter = await opened({ worstCase: true });
      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 105, 94) });

      expect(result.closed[0].exitReason).toBe('sl');
    });

    it('closes on expiry at the bar close', async () => {
      const adapter = new PaperAdapter();
      await adapter.placeEntry(makeSignal(98, 95, 104, bar(3)));
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 99, 97.5) }); // fill

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 99, 97, 98.5) });

      expect(result.closed[0].exitReason).toBe('expiry');
      expect(result.closed[0].exitPrice).toBe(98.5);
    });

    it('closePosition exits at the last seen close', async () => {
      const adapter = await opened();
      await adapter.sync({ symbol: SYMBOL, candle: candle(2, 99.5, 98, 99) });

      const trade = await adapter.closePosition(SYMBOL, 'strategy');

      expect(trade?.exitReason).toBe('strategy');
      expect(trade?.exitPrice).toBe(99);
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });
  });

  describe('journal and restore', () => {
    it('replays a full lifecycle into identical state', async () => {
      const journal = new MemoryJournal();
      const live = new PaperAdapter({ initialBalance: 10_000, feeRate: 0.001, journal });

      await live.placeEntry(makeSignal(98, 95, 104));
      await live.sync({ symbol: SYMBOL, candle: candle(1, 99, 97.5) }); // fill
      await live.sync({ symbol: SYMBOL, candle: candle(2, 104.5, 99) }); // tp
      await live.placeEntry(makeSignal(98, 95, 104));

      const restored = PaperAdapter.restore({ initialBalance: 10_000, feeRate: 0.001, journal });

      expect(restored.balance).toBe(live.balance);
      expect(await restored.getClosedTrades()).toHaveLength(1);
      expect((await restored.getClosedTrades())[0].pnlPct).toBe(
        (await live.getClosedTrades())[0].pnlPct,
      );
      const restingLive = await live.getRestingEntry(SYMBOL);
      const restingRestored = await restored.getRestingEntry(SYMBOL);
      expect(restingRestored?.orderId).toBe(restingLive?.orderId);
      expect(restingRestored?.signal.entry).toBe(98);
    });

    it('restores an open position mid-flight', async () => {
      const journal = new MemoryJournal();
      const live = new PaperAdapter({ initialBalance: 10_000, journal });
      await live.placeEntry(makeSignal(98, 95, 104));
      await live.sync({ symbol: SYMBOL, candle: candle(1, 99, 97.5) }); // filled, still open

      const restored = PaperAdapter.restore({ initialBalance: 10_000, journal });
      const position = await restored.getPosition(SYMBOL);

      expect(position?.entryPrice).toBe(98);
      expect(position?.entryTime).toBe(bar(1));
      expect(await restored.getRestingEntry(SYMBOL)).toBeNull();

      // ...and the restored adapter can settle it.
      const result = await restored.sync({ symbol: SYMBOL, candle: candle(2, 104.5, 99) });
      expect(result.closed[0].exitReason).toBe('tp');
    });

    it('does not double-write events while replaying', async () => {
      const journal = new MemoryJournal();
      const live = new PaperAdapter({ journal });
      await live.placeEntry(makeSignal());
      const countBefore = journal.events.length;

      PaperAdapter.restore({ journal });

      expect(journal.events.length).toBe(countBefore);
    });
  });
});
