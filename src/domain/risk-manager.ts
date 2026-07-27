import { Signal } from './signal';

/**
 * Position sizing and account-level guards.
 *
 * Note: `BacktestAdapter` still sizes positions itself (the Python code did
 * too), so this class is currently only used by callers that opt in. Keeping
 * the formula in one place is what makes the paper/live adapters able to share
 * it later without touching strategy code.
 */
export class RiskManager {
  constructor(
    readonly riskPerTrade = 0.01,
    readonly maxDailyDrawdown = 0.03,
  ) {}

  positionSize(balance: number, entry: number, stopLoss: number): number {
    return (balance * this.riskPerTrade) / Math.abs(entry - stopLoss);
  }

  validateSignal(_signal: Signal, _balance: number, dailyPnl: number): boolean {
    return dailyPnl >= -this.maxDailyDrawdown;
  }
}
