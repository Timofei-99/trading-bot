import { dailyRealizedPnl, KillSwitch } from './kill-switch';
import { Direction, Signal } from './signal';
import { Trade } from './trade';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 2); // a full day in, so "yesterday" exists

/** A closed trade with the given PnL fraction and exit time. */
function closedTrade(pnlPct: number, exitTime: number): Trade {
  const entry = 100;
  const signal = new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry,
    stopLoss: 90,
    takeProfit: 130,
    timeframe: '15m',
    timestamp: exitTime,
    strategyName: 'test',
    strategyVersion: '1',
  });
  const trade = new Trade({
    signal,
    orderId: `o-${exitTime}-${pnlPct}`,
    entryTime: exitTime,
    entryPrice: entry,
    positionSize: 1,
  });
  trade.exitPrice = entry * (1 + pnlPct);
  trade.exitTime = exitTime;
  trade.exitReason = pnlPct >= 0 ? 'tp' : 'sl';
  return trade;
}

describe('dailyRealizedPnl', () => {
  it('counts only trades closed on the same UTC day', () => {
    const trades = [
      closedTrade(-0.05, T0 - DAY + 3_600_000), // yesterday
      closedTrade(-0.02, T0 + 3_600_000),
      closedTrade(-0.03, T0 + 7_200_000),
    ];
    expect(dailyRealizedPnl(trades, T0 + 10_800_000)).toBeCloseTo(-0.05, 12);
  });

  it('ignores trades that close later than now', () => {
    const trades = [closedTrade(-0.02, T0 + 3_600_000), closedTrade(-0.5, T0 + 20 * 3_600_000)];
    expect(dailyRealizedPnl(trades, T0 + 7_200_000)).toBeCloseTo(-0.02, 12);
  });

  it('is zero with nothing closed', () => {
    expect(dailyRealizedPnl([], T0)).toBe(0);
  });
});

describe('KillSwitch', () => {
  it('does nothing when unconfigured', () => {
    const guard = new KillSwitch();
    expect(guard.evaluate([closedTrade(-0.9, T0)], T0)).toBeNull();
    expect(guard.isHalted).toBe(false);
  });

  describe('daily drawdown', () => {
    const guard = (): KillSwitch => new KillSwitch({ maxDailyDrawdown: 0.05 });

    it('stays quiet below the limit', () => {
      expect(guard().evaluate([closedTrade(-0.04, T0)], T0)).toBeNull();
    });

    it('trips exactly at the limit', () => {
      const reason = guard().evaluate([closedTrade(-0.05, T0)], T0);
      expect(reason).toMatch(/daily loss -5\.00% reached the 5\.00% limit/);
    });

    it('trips on the sum of several losses', () => {
      const trades = [closedTrade(-0.03, T0), closedTrade(-0.03, T0 + 3_600_000)];
      expect(guard().evaluate(trades, T0 + 7_200_000)).not.toBeNull();
    });

    it('does not trip on losses from a previous day', () => {
      expect(guard().evaluate([closedTrade(-0.5, T0 - DAY)], T0)).toBeNull();
    });

    it('is offset by wins on the same day', () => {
      const trades = [closedTrade(-0.06, T0), closedTrade(0.03, T0 + 60_000)];
      expect(guard().evaluate(trades, T0 + 120_000)).toBeNull();
    });
  });

  describe('consecutive losses', () => {
    const guard = (): KillSwitch => new KillSwitch({ maxConsecutiveLosses: 3 });

    it('counts backwards from the most recent trade', () => {
      const trades = [
        closedTrade(-0.01, T0),
        closedTrade(-0.01, T0 + 1),
        closedTrade(-0.01, T0 + 2),
      ];
      expect(guard().evaluate(trades, T0 + 3)).toMatch(/3 consecutive losing trades/);
    });

    it('is reset by a win', () => {
      const trades = [
        closedTrade(-0.01, T0),
        closedTrade(-0.01, T0 + 1),
        closedTrade(0.01, T0 + 2),
        closedTrade(-0.01, T0 + 3),
      ];
      expect(guard().evaluate(trades, T0 + 4)).toBeNull();
    });

    it('counts across days, unlike the drawdown rule', () => {
      const trades = [
        closedTrade(-0.01, T0 - DAY),
        closedTrade(-0.01, T0 - DAY + 1),
        closedTrade(-0.01, T0),
      ];
      expect(guard().evaluate(trades, T0 + 1)).not.toBeNull();
    });
  });

  describe('halt state', () => {
    it('stays halted until deliberately resumed', () => {
      const guard = new KillSwitch({ maxDailyDrawdown: 0.05 });
      guard.halt('manual stop');

      expect(guard.isHalted).toBe(true);
      expect(guard.reason).toBe('manual stop');

      guard.resume();
      expect(guard.isHalted).toBe(false);
      expect(guard.reason).toBeNull();
    });
  });
});
