import { Direction, Signal } from './signal';
import { Trade } from './trade';

const TIMESTAMP = Date.UTC(2024, 0, 1);

function makeTrade(direction: Direction, entry: number, stopLoss: number): Trade {
  const signal = new Signal({
    symbol: 'BTC/USDT',
    direction,
    entry,
    stopLoss,
    takeProfit: direction === Direction.Long ? entry + 30 : entry - 30,
    timeframe: '1h',
    timestamp: TIMESTAMP,
    strategyName: 'test',
    strategyVersion: '1.0',
  });
  return new Trade({
    signal,
    orderId: 'order-1',
    entryTime: TIMESTAMP,
    entryPrice: entry,
    positionSize: 2,
  });
}

describe('Trade', () => {
  it('has no result while it is open', () => {
    const trade = makeTrade(Direction.Long, 100, 90);
    expect(trade.pnlPct).toBeNull();
    expect(trade.pnlR).toBeNull();
    expect(trade.isWinner).toBeNull();
  });

  it('computes long PnL from the exit price', () => {
    const trade = makeTrade(Direction.Long, 100, 90);
    trade.exitPrice = 110;
    expect(trade.pnlPct).toBeCloseTo(0.1, 12);
    expect(trade.pnlR).toBeCloseTo(1, 12);
    expect(trade.isWinner).toBe(true);
  });

  it('computes short PnL with the sign flipped', () => {
    const trade = makeTrade(Direction.Short, 100, 110);
    trade.exitPrice = 90;
    expect(trade.pnlPct).toBeCloseTo(0.1, 12);
    expect(trade.pnlR).toBeCloseTo(1, 12);
    expect(trade.isWinner).toBe(true);
  });

  it('marks a losing exit', () => {
    const trade = makeTrade(Direction.Long, 100, 90);
    trade.exitPrice = 95;
    expect(trade.pnlPct).toBeCloseTo(-0.05, 12);
    expect(trade.isWinner).toBe(false);
  });

  it('treats a flat exit as a loss, since the test is pnl > 0', () => {
    const trade = makeTrade(Direction.Long, 100, 90);
    trade.exitPrice = 100;
    expect(trade.pnlPct).toBe(0);
    expect(trade.isWinner).toBe(false);
  });

  it('has no R multiple when the signal carried no risk', () => {
    const trade = makeTrade(Direction.Long, 100, 100);
    trade.exitPrice = 110;
    expect(trade.pnlR).toBeNull();
    expect(trade.pnlPct).toBeCloseTo(0.1, 12);
  });
});
