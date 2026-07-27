import { Direction, Signal } from './signal';

const TIMESTAMP = Date.UTC(2024, 0, 1);

function makeSignal(
  direction: Direction,
  entry: number,
  stopLoss: number,
  takeProfit: number,
): Signal {
  return new Signal({
    symbol: 'BTC/USDT',
    direction,
    entry,
    stopLoss,
    takeProfit,
    timeframe: '1h',
    timestamp: TIMESTAMP,
    strategyName: 'test',
    strategyVersion: '1.0',
  });
}

const long = (entry: number, sl: number, tp: number): Signal =>
  makeSignal(Direction.Long, entry, sl, tp);
const short = (entry: number, sl: number, tp: number): Signal =>
  makeSignal(Direction.Short, entry, sl, tp);

describe('Signal', () => {
  it('measures risk as distance to the stop, either direction', () => {
    expect(long(100, 90, 130).riskAmount).toBe(10);
    expect(short(100, 110, 70).riskAmount).toBe(10);
  });

  it('measures reward as distance to the target, either direction', () => {
    expect(long(100, 90, 130).rewardAmount).toBe(30);
    expect(short(100, 110, 70).rewardAmount).toBe(30);
  });

  it('derives risk/reward from those two', () => {
    expect(long(100, 90, 130).riskReward).toBeCloseTo(3, 12);
    expect(short(100, 110, 70).riskReward).toBeCloseTo(3, 12);
    expect(long(100, 95, 120).riskReward).toBeGreaterThan(0);
  });

  it('defaults triggeredBy, meta and expiryTime', () => {
    const signal = long(100, 90, 130);
    expect(signal.triggeredBy).toEqual([]);
    expect(signal.meta).toEqual({});
    expect(signal.expiryTime).toBeNull();
  });

  it('keeps the wire values of the directions', () => {
    expect(Direction.Long).toBe('long');
    expect(Direction.Short).toBe('short');
  });
});
