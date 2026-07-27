import { Direction, Signal } from '../domain/signal';
import { BacktestAdapter } from './backtest.adapter';

const SYMBOL = 'BTC/USDT';
const DAY1 = Date.UTC(2024, 0, 1);
const DAY2 = Date.UTC(2024, 0, 2);
const DAY3 = Date.UTC(2024, 0, 3);

function makeSignal(
  direction: Direction = Direction.Long,
  entry = 100,
  stopLoss = 90,
  takeProfit = 130,
  expiryTime: number | null = null,
): Signal {
  return new Signal({
    symbol: SYMBOL,
    direction,
    entry,
    stopLoss,
    takeProfit,
    timeframe: '1h',
    timestamp: DAY1,
    strategyName: 'test',
    strategyVersion: '1.0',
    expiryTime,
  });
}

describe('BacktestAdapter', () => {
  describe('placing orders', () => {
    it('opens a position that is not yet a closed trade', () => {
      const adapter = new BacktestAdapter();
      const orderId = adapter.placeOrder(makeSignal());

      expect(orderId).toEqual(expect.any(String));
      expect(adapter.getPosition(SYMBOL)).not.toBeNull();
      expect(adapter.openTrades).toHaveLength(1);
      expect(adapter.trades).toHaveLength(0);
    });

    it('reports no position for an unknown symbol', () => {
      expect(new BacktestAdapter().getPosition('ETH/USDT')).toBeNull();
    });

    it('sizes the position so the stop costs riskPerTrade of the balance', () => {
      const adapter = new BacktestAdapter({ initialBalance: 10_000, riskPerTrade: 0.01 });
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      // 1% of 10 000 = 100 risked over a 10-point stop.
      expect(adapter.openTrades[0].positionSize).toBeCloseTo(10, 12);
    });
  });

  describe('settling a bar', () => {
    it('closes a long at the target when the high reaches it', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Long));
      adapter.update(SYMBOL, 135, 105, DAY2);

      expect(adapter.trades).toHaveLength(1);
      expect(adapter.trades[0].exitReason).toBe('tp');
      expect(adapter.trades[0].exitPrice).toBe(130);
      expect(adapter.trades[0].exitTime).toBe(DAY2);
    });

    it('closes a long at the stop when the low reaches it', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Long));
      adapter.update(SYMBOL, 105, 85, DAY2);

      expect(adapter.trades[0].exitReason).toBe('sl');
      expect(adapter.trades[0].exitPrice).toBe(90);
    });

    it('resolves a bar that spans both levels in favour of the target', () => {
      // Intraday sequencing is unknowable from OHLC alone; the original
      // implementation checked TP first and the historical record depends on it.
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Long));
      adapter.update(SYMBOL, 135, 85, DAY2);

      expect(adapter.trades).toHaveLength(1);
      expect(adapter.trades[0].exitReason).toBe('tp');
    });

    it('mirrors the level checks for a short', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Short, 100, 110, 70));
      adapter.update(SYMBOL, 105, 65, DAY2);

      expect(adapter.trades[0].exitReason).toBe('tp');
      expect(adapter.trades[0].exitPrice).toBe(70);
    });

    it('leaves the position open when the bar reaches neither level', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal());
      adapter.update(SYMBOL, 120, 95, DAY2);

      expect(adapter.trades).toHaveLength(0);
      expect(adapter.openTrades).toHaveLength(1);
    });

    it('does nothing when there is no position', () => {
      const adapter = new BacktestAdapter();
      expect(() => adapter.update(SYMBOL, 135, 85, DAY2)).not.toThrow();
      expect(adapter.trades).toHaveLength(0);
    });

    describe('expiry', () => {
      it('closes at the close price once the expiry time passes', () => {
        const adapter = new BacktestAdapter();
        adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130, DAY2));
        adapter.update(SYMBOL, 120, 95, DAY2, 110);

        expect(adapter.trades[0].exitReason).toBe('expiry');
        expect(adapter.trades[0].exitPrice).toBe(110);
      });

      it('falls back to the bar midpoint when no close is supplied', () => {
        const adapter = new BacktestAdapter();
        adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130, DAY2));
        adapter.update(SYMBOL, 120, 96, DAY2);

        expect(adapter.trades[0].exitPrice).toBe((120 + 96) / 2);
      });

      it('yields to TP and SL on the same bar', () => {
        const adapter = new BacktestAdapter();
        adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130, DAY2));
        adapter.update(SYMBOL, 135, 95, DAY2, 110);

        expect(adapter.trades[0].exitReason).toBe('tp');
      });
    });
  });

  describe('balance', () => {
    it('credits a winning trade', () => {
      const adapter = new BacktestAdapter({ initialBalance: 10_000, riskPerTrade: 0.01 });
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 135, 105, DAY2);

      // 10 units * (130 - 100) = 300.
      expect(adapter.balance).toBeCloseTo(10_300, 9);
    });

    it('debits a losing trade', () => {
      const adapter = new BacktestAdapter({ initialBalance: 10_000, riskPerTrade: 0.01 });
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 105, 85, DAY2);

      // 10 units * (90 - 100) = -100, the configured risk.
      expect(adapter.balance).toBeCloseTo(9_900, 9);
    });
  });

  describe('closePosition', () => {
    it('closes at the stop and tags the exit as manual', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.closePosition(SYMBOL);

      expect(adapter.trades).toHaveLength(1);
      expect(adapter.trades[0].exitReason).toBe('manual');
      expect(adapter.trades[0].exitPrice).toBe(90);
    });

    it('is a no-op without a position', () => {
      const adapter = new BacktestAdapter();
      expect(() => adapter.closePosition(SYMBOL)).not.toThrow();
    });
  });

  describe('report', () => {
    it('is all zeros before anything closes', () => {
      expect(new BacktestAdapter().report()).toEqual({
        totalTrades: 0,
        winners: 0,
        losers: 0,
        winRate: 0,
        profitFactor: 0,
        totalPnlPct: 0,
        maxDrawdownPct: 0,
      });
    });

    it('counts winners and losers', () => {
      const adapter = new BacktestAdapter();

      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 135, 105, DAY2);

      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 105, 85, DAY3);

      const report = adapter.report();
      expect(report.totalTrades).toBe(2);
      expect(report.winners).toBe(1);
      expect(report.losers).toBe(1);
      expect(report.winRate).toBeCloseTo(0.5, 12);
    });

    it('reports an infinite profit factor when nothing lost', () => {
      const adapter = new BacktestAdapter();
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 135, 105, DAY2);

      expect(adapter.report().profitFactor).toBe(Number.POSITIVE_INFINITY);
    });

    it('tracks the deepest drawdown of the equity curve', () => {
      const adapter = new BacktestAdapter();

      // +30%, then -10%, then -10%: peak after trade 1, trough after trade 3.
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 135, 105, DAY2);
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 105, 85, DAY2);
      adapter.placeOrder(makeSignal(Direction.Long, 100, 90, 130));
      adapter.update(SYMBOL, 105, 85, DAY3);

      const report = adapter.report();
      expect(report.totalPnlPct).toBeCloseTo(0.3 - 0.1 - 0.1, 12);
      expect(report.maxDrawdownPct).toBeCloseTo(0.2, 12);
    });
  });

  it('hands out copies of its trade lists', () => {
    const adapter = new BacktestAdapter();
    adapter.placeOrder(makeSignal());

    adapter.openTrades.pop();
    expect(adapter.openTrades).toHaveLength(1);
  });
});
