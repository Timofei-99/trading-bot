/**
 * A strategy's trade intent — the output currency of every strategy.
 *
 * `entry` must be a price level derived from bars *before* the signal bar
 * (an FVG boundary, an order-block edge, a session level). The engine places
 * the order and checks TP/SL on the same bar, which models a resting limit
 * order; deriving `entry` from the signal bar's own OHLC would reintroduce
 * look-ahead bias.
 */

export enum Direction {
  Long = 'long',
  Short = 'short',
}

export type SignalMeta = Record<string, unknown>;

export interface SignalInit {
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly timeframe: string;
  /** Epoch ms of the last bar visible when the signal was produced. */
  readonly timestamp: number;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly triggeredBy?: readonly string[];
  readonly meta?: SignalMeta;
  readonly expiryTime?: number | null;
}

export class Signal {
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly timeframe: string;
  readonly timestamp: number;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly triggeredBy: readonly string[];
  readonly meta: SignalMeta;
  readonly expiryTime: number | null;

  constructor(init: SignalInit) {
    this.symbol = init.symbol;
    this.direction = init.direction;
    this.entry = init.entry;
    this.stopLoss = init.stopLoss;
    this.takeProfit = init.takeProfit;
    this.timeframe = init.timeframe;
    this.timestamp = init.timestamp;
    this.strategyName = init.strategyName;
    this.strategyVersion = init.strategyVersion;
    this.triggeredBy = init.triggeredBy ?? [];
    this.meta = init.meta ?? {};
    this.expiryTime = init.expiryTime ?? null;
  }

  get riskAmount(): number {
    return Math.abs(this.entry - this.stopLoss);
  }

  get rewardAmount(): number {
    return Math.abs(this.takeProfit - this.entry);
  }

  get riskReward(): number {
    return this.rewardAmount / this.riskAmount;
  }
}
