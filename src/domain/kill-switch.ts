import { Trade } from './trade';

const DAY_MS = 86_400_000;

export interface KillSwitchOptions {
  /** Halt once the day's realized loss reaches this fraction, e.g. 0.03. */
  readonly maxDailyDrawdown?: number;
  /** Halt after this many consecutive losing trades. */
  readonly maxConsecutiveLosses?: number;
}

/**
 * The stop that outranks the strategy.
 *
 * `RiskManager` answers "is this one signal acceptable?" and lets the next bar
 * try again. This answers "should this bot still be trading at all?" — and
 * once tripped it stays tripped, including across restarts, because the halt
 * is recorded in the journal and replayed on startup. A bot that resumes by
 * itself after hitting a loss limit is not a loss limit.
 *
 * Halting stops NEW entries and cancels resting orders. It deliberately does
 * NOT flatten an open position: the exits already sit at the venue, and
 * market-selling on the way out would realize a loss that the stop might not
 * have taken. Flattening is a manual decision.
 */
export class KillSwitch {
  readonly maxDailyDrawdown: number | null;
  readonly maxConsecutiveLosses: number | null;

  private haltReason: string | null = null;

  constructor(options: KillSwitchOptions = {}) {
    this.maxDailyDrawdown = options.maxDailyDrawdown ?? null;
    this.maxConsecutiveLosses = options.maxConsecutiveLosses ?? null;
  }

  get isHalted(): boolean {
    return this.haltReason !== null;
  }

  get reason(): string | null {
    return this.haltReason;
  }

  halt(reason: string): void {
    this.haltReason = reason;
  }

  /** Only ever called deliberately — by an operator, never by the loop. */
  resume(): void {
    this.haltReason = null;
  }

  /**
   * Reason to halt given the trades closed so far, or null to keep trading.
   * Pure: the caller decides what to do with the answer.
   */
  evaluate(closedTrades: readonly Trade[], nowMs: number): string | null {
    if (this.maxDailyDrawdown !== null) {
      const daily = dailyRealizedPnl(closedTrades, nowMs);
      if (daily <= -this.maxDailyDrawdown) {
        return (
          `daily loss ${(daily * 100).toFixed(2)}% reached the ` +
          `${(this.maxDailyDrawdown * 100).toFixed(2)}% limit`
        );
      }
    }

    if (this.maxConsecutiveLosses !== null) {
      const streak = losingStreak(closedTrades);
      if (streak >= this.maxConsecutiveLosses) {
        return `${streak} consecutive losing trades reached the limit of ${this.maxConsecutiveLosses}`;
      }
    }

    return null;
  }
}

/** Realized PnL of trades closed on the same UTC day as `nowMs`. */
export function dailyRealizedPnl(closedTrades: readonly Trade[], nowMs: number): number {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  let total = 0;
  for (const trade of closedTrades) {
    if (trade.exitTime !== null && trade.exitTime >= dayStart && trade.exitTime <= nowMs) {
      total += trade.pnlPct ?? 0;
    }
  }
  return total;
}

function losingStreak(closedTrades: readonly Trade[]): number {
  let streak = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if (closedTrades[i].isWinner === false) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}
