import { RiskManager } from './risk-manager';
import { Direction, Signal } from './signal';

const signal = new Signal({
  symbol: 'BTC/USDT',
  direction: Direction.Long,
  entry: 100,
  stopLoss: 90,
  takeProfit: 130,
  timeframe: '1h',
  timestamp: Date.UTC(2024, 0, 1),
  strategyName: 'test',
  strategyVersion: '1.0',
});

describe('RiskManager', () => {
  it('sizes a position so the stop costs riskPerTrade of the balance', () => {
    const manager = new RiskManager(0.01);
    // 1% of 10 000 = 100 risked over a 10-point stop => 10 units.
    expect(manager.positionSize(10_000, 100, 90)).toBeCloseTo(10, 12);
  });

  it('ignores the direction of the stop distance', () => {
    const manager = new RiskManager(0.02);
    expect(manager.positionSize(10_000, 100, 110)).toBeCloseTo(
      manager.positionSize(10_000, 100, 90),
      12,
    );
  });

  it('accepts a signal while the daily loss is within the cap', () => {
    const manager = new RiskManager(0.01, 0.03);
    expect(manager.validateSignal(signal, 10_000, -0.02)).toBe(true);
    expect(manager.validateSignal(signal, 10_000, 0.05)).toBe(true);
  });

  it('accepts a signal exactly at the cap and rejects beyond it', () => {
    const manager = new RiskManager(0.01, 0.03);
    expect(manager.validateSignal(signal, 10_000, -0.03)).toBe(true);
    expect(manager.validateSignal(signal, 10_000, -0.031)).toBe(false);
  });
});
