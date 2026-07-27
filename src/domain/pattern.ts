/**
 * A detected ICT construct — the output currency of every detector.
 *
 * Detectors stash typed facts in `meta` (an order block's `direction` and
 * `mitigated`, a liquidity level's `side` and `swept`, …) and strategies read
 * them back by key, so a detector's docstring is the contract for its `meta`.
 * Timestamps inside `meta` are epoch milliseconds, session dates are
 * `YYYY-MM-DD` strings — the same shapes the golden fixtures record.
 */

export enum PatternType {
  OrderBlock = 'order_block',
  Fvg = 'fvg',
  Liquidity = 'liquidity',
  Bos = 'bos',
  Choch = 'choch',
  PremiumDiscount = 'premium_discount',
  Killzone = 'killzone',
  Snr = 'snr',
  Fractal = 'fractal',
  InitialBalance = 'initial_balance',
}

export type PatternMeta = Record<string, unknown>;

export interface PatternInit {
  readonly type: PatternType;
  readonly timeframe: string;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly high: number;
  readonly low: number;
  readonly meta?: PatternMeta;
}

export class Pattern {
  readonly type: PatternType;
  readonly timeframe: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly high: number;
  readonly low: number;
  readonly meta: PatternMeta;

  constructor(init: PatternInit) {
    this.type = init.type;
    this.timeframe = init.timeframe;
    this.startTime = init.startTime;
    this.endTime = init.endTime ?? null;
    this.high = init.high;
    this.low = init.low;
    this.meta = init.meta ?? {};
  }

  /** 50% equilibrium of the zone. */
  get mid(): number {
    return (this.high + this.low) / 2;
  }

  isActive(currentTime: number): boolean {
    return this.endTime === null || currentTime <= this.endTime;
  }
}
