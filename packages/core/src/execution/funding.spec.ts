import { Direction, Signal } from '../domain/signal';
import { BacktestAdapter } from './backtest.adapter';
import { PaperAdapter } from './paper.adapter';
import { FUNDING_INTERVAL_MS, fundingCharge, fundingEventsBetween } from './funding';

const H8 = FUNDING_INTERVAL_MS;
/** A funding boundary, exactly. */
const B = Math.ceil(Date.UTC(2024, 0, 1) / H8) * H8;

describe('fundingEventsBetween', () => {
  it('counts the boundaries inside a plain interval', () => {
    expect(fundingEventsBetween(B - 1, B + 1)).toBe(1);
    expect(fundingEventsBetween(B - 1, B + 2 * H8)).toBe(3);
  });

  it('charges a boundary exactly once across consecutive bars', () => {
    // Half-open on the left: the bar that ends ON the boundary pays it, and
    // the next bar starts counting strictly after.
    const barEnd = B;
    expect(fundingEventsBetween(B - H8, barEnd)).toBe(1);
    expect(fundingEventsBetween(barEnd, barEnd + H8 - 1)).toBe(0);
  });

  it('is zero inside one interval and for empty or reversed spans', () => {
    expect(fundingEventsBetween(B + 1, B + H8 - 1)).toBe(0);
    expect(fundingEventsBetween(B, B)).toBe(0);
    expect(fundingEventsBetween(B + 1, B)).toBe(0);
  });
});

describe('fundingCharge', () => {
  it('makes a long pay a positive rate', () => {
    expect(fundingCharge(Direction.Long, 2, 100, 0.0001, 3)).toBeCloseTo(0.06, 12);
  });

  it('pays the same rate TO a short', () => {
    // Funding is the one cost in this model that can be an income.
    expect(fundingCharge(Direction.Short, 2, 100, 0.0001, 3)).toBeCloseTo(-0.06, 12);
  });

  it('flips both signs under a negative rate', () => {
    expect(fundingCharge(Direction.Long, 2, 100, -0.0001, 1)).toBeLessThan(0);
    expect(fundingCharge(Direction.Short, 2, 100, -0.0001, 1)).toBeGreaterThan(0);
  });
});

describe('funding in the backtest adapter', () => {
  /** Open at B-1h, hold across two boundaries, expire at B+8h+1h flat. */
  function runHeld(direction: Direction, fundingRatePer8h: number): BacktestAdapter {
    const adapter = new BacktestAdapter({ initialBalance: 10_000, fundingRatePer8h });
    adapter.placeOrder(
      new Signal({
        symbol: 'BTC/USDT:USDT',
        direction,
        entry: 100,
        stopLoss: direction === Direction.Long ? 90 : 110,
        takeProfit: direction === Direction.Long ? 120 : 80,
        timeframe: '1h',
        timestamp: B - 3_600_000,
        strategyName: 'test',
        strategyVersion: '1',
        expiryTime: B + H8 + 3_600_000,
      }),
    );
    // Hourly flat bars that never touch the levels.
    for (let t = B - 3_600_000; t <= B + H8 + 3_600_000; t += 3_600_000) {
      adapter.update('BTC/USDT:USDT', 101, 99, t, 100);
    }
    return adapter;
  }

  it('charges a long once per boundary held through', () => {
    const adapter = runHeld(Direction.Long, 0.0001);
    const [trade] = adapter.trades;

    // Two boundaries (B and B+8h) at mark 100 on the adapter's size.
    expect(trade.fundingCost).toBeCloseTo(trade.positionSize * 100 * 0.0001 * 2, 12);
    expect(trade.pnlPct as number).toBeLessThan(0);
  });

  it('credits a short the same amount', () => {
    const adapter = runHeld(Direction.Short, 0.0001);
    const [trade] = adapter.trades;

    expect(trade.fundingCost).toBeLessThan(0);
    expect(trade.pnlPct as number).toBeGreaterThan(0);
  });

  it('moves the balance by exactly the funding on a flat round trip', () => {
    const adapter = runHeld(Direction.Long, 0.0001);
    const [trade] = adapter.trades;

    expect(adapter.balance).toBeCloseTo(10_000 - trade.fundingCost, 9);
  });

  it('changes nothing at the default rate of zero', () => {
    const charged = runHeld(Direction.Long, 0);
    const [trade] = charged.trades;

    expect(trade.fundingCost).toBe(0);
    expect(charged.balance).toBe(10_000);
    expect(trade.pnlPct).toBe(0);
  });
});

describe('funding in the paper adapter', () => {
  const H1 = 3_600_000;
  const flat = (time: number) => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1 });

  it('accrues on a held position and settles into the close', async () => {
    const adapter = new PaperAdapter({ initialBalance: 10_000, fundingRatePer8h: 0.0001 });
    await adapter.placeEntry(
      new Signal({
        symbol: 'BTC/USDT:USDT',
        direction: Direction.Long,
        entry: 100,
        stopLoss: 90,
        takeProfit: 120,
        timeframe: '1h',
        timestamp: B - 2 * H1,
        strategyName: 'test',
        strategyVersion: '1',
      }),
    );

    // Fill on the next bar, hold across the boundary at B, exit at the target.
    await adapter.sync({ symbol: 'BTC/USDT:USDT', candle: flat(B - H1) });
    await adapter.sync({ symbol: 'BTC/USDT:USDT', candle: flat(B + H1) });
    await adapter.sync({
      symbol: 'BTC/USDT:USDT',
      candle: { time: B + 2 * H1, open: 100, high: 121, low: 100, close: 120, volume: 1 },
    });

    const [trade] = await adapter.getClosedTrades();
    expect(trade.fundingCost).toBeGreaterThan(0);
    expect(trade.pnlPct as number).toBeLessThan(0.2); // funding shaved the gross 20%
  });

  it('stays inert at the default rate', async () => {
    const adapter = new PaperAdapter({ initialBalance: 10_000 });
    await adapter.placeEntry(
      new Signal({
        symbol: 'BTC/USDT:USDT',
        direction: Direction.Long,
        entry: 100,
        stopLoss: 90,
        takeProfit: 120,
        timeframe: '1h',
        timestamp: B - 2 * H1,
        strategyName: 'test',
        strategyVersion: '1',
      }),
    );
    await adapter.sync({ symbol: 'BTC/USDT:USDT', candle: flat(B - H1) });
    await adapter.sync({ symbol: 'BTC/USDT:USDT', candle: flat(B + H1) });

    expect((await adapter.getPosition('BTC/USDT:USDT'))?.fundingCost).toBe(0);
  });
});
