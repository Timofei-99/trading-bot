import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { sortByStartTime, swingHighIndices, swingLowIndices } from './swings';

export interface OrderBlockOptions {
  readonly swingLength?: number;
  readonly lookback?: number;
  readonly timeframe?: string;
  /** Use the candle body as the zone (default) instead of the full wick range. */
  readonly useBody?: boolean;
}

/**
 * ICT Order Blocks at confirmed swing highs and lows.
 *
 * Bullish OB: the last bearish candle (close < open) within `lookback` bars
 *             before a swing low. Zone = body [close, open].
 * Bearish OB: the last bullish candle (close > open) within `lookback` bars
 *             before a swing high. Zone = body [open, close].
 *
 * `endTime` is the first candle where price re-enters the zone after having
 * cleared it; null means the block is still unmitigated.
 *
 * Mitigation is TWO-PHASE, one direction at a time:
 *   Bullish — price must first CLOSE ABOVE `high`, and only then may a later
 *             candle's LOW reaching back to `high` count as mitigation.
 *   Bearish — price must first CLOSE BELOW `low`, then a later candle's HIGH
 *             must reach back up to `low`.
 * Without the first phase the departure candle itself would mitigate the block
 * it just created.
 *
 * meta: `direction`, `swing_time` (epoch ms of the pivot), `mitigated`.
 */
export class OrderBlockDetector implements Detector {
  readonly swingLength: number;
  readonly lookback: number;
  readonly timeframe: string;
  readonly useBody: boolean;

  constructor(options: OrderBlockOptions = {}) {
    this.swingLength = options.swingLength ?? 3;
    this.lookback = options.lookback ?? 5;
    this.timeframe = options.timeframe ?? '';
    this.useBody = options.useBody ?? true;
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < this.swingLength * 2 + 1) {
      return [];
    }

    const patterns: Pattern[] = [];

    for (const index of swingLowIndices(candles, this.swingLength)) {
      const pattern = this.bullishOrderBlock(candles, index);
      if (pattern !== null) {
        patterns.push(pattern);
      }
    }

    for (const index of swingHighIndices(candles, this.swingLength)) {
      const pattern = this.bearishOrderBlock(candles, index);
      if (pattern !== null) {
        patterns.push(pattern);
      }
    }

    return sortByStartTime(patterns);
  }

  /** Last bearish candle at or before the swing low. */
  private bullishOrderBlock(candles: CandleSeries, swingLowIndex: number): Pattern | null {
    const { open, close, high, low, time } = candles;
    const start = Math.max(0, swingLowIndex - this.lookback);

    let obIndex: number | null = null;
    for (let i = start; i <= swingLowIndex; i++) {
      if (close[i] < open[i]) {
        obIndex = i;
      }
    }
    if (obIndex === null) {
      return null;
    }

    const obHigh = this.useBody ? open[obIndex] : high[obIndex];
    const obLow = this.useBody ? close[obIndex] : low[obIndex];
    const mitigated = this.mitigationBullish(candles, obHigh, swingLowIndex + 1);

    return new Pattern({
      type: PatternType.OrderBlock,
      timeframe: this.timeframe,
      startTime: time[obIndex],
      endTime: mitigated,
      high: obHigh,
      low: obLow,
      meta: {
        direction: 'bullish',
        swing_time: time[swingLowIndex],
        mitigated: mitigated !== null,
      },
    });
  }

  /** Last bullish candle at or before the swing high. */
  private bearishOrderBlock(candles: CandleSeries, swingHighIndex: number): Pattern | null {
    const { open, close, high, low, time } = candles;
    const start = Math.max(0, swingHighIndex - this.lookback);

    let obIndex: number | null = null;
    for (let i = start; i <= swingHighIndex; i++) {
      if (close[i] > open[i]) {
        obIndex = i;
      }
    }
    if (obIndex === null) {
      return null;
    }

    const obHigh = this.useBody ? close[obIndex] : high[obIndex];
    const obLow = this.useBody ? open[obIndex] : low[obIndex];
    const mitigated = this.mitigationBearish(candles, obLow, swingHighIndex + 1);

    return new Pattern({
      type: PatternType.OrderBlock,
      timeframe: this.timeframe,
      startTime: time[obIndex],
      endTime: mitigated,
      high: obHigh,
      low: obLow,
      meta: {
        direction: 'bearish',
        swing_time: time[swingHighIndex],
        mitigated: mitigated !== null,
      },
    });
  }

  /** Phase 1: a close above the zone. Phase 2: a later low back inside it. */
  private mitigationBullish(
    candles: CandleSeries,
    obHigh: number,
    startIndex: number,
  ): number | null {
    const { close, low, time } = candles;

    let departure = -1;
    for (let i = startIndex; i < candles.length; i++) {
      if (close[i] > obHigh) {
        departure = i;
        break;
      }
    }
    if (departure < 0) {
      return null;
    }

    for (let i = departure + 1; i < candles.length; i++) {
      if (low[i] <= obHigh) {
        return time[i];
      }
    }
    return null;
  }

  /** Phase 1: a close below the zone. Phase 2: a later high back inside it. */
  private mitigationBearish(
    candles: CandleSeries,
    obLow: number,
    startIndex: number,
  ): number | null {
    const { close, high, time } = candles;

    let departure = -1;
    for (let i = startIndex; i < candles.length; i++) {
      if (close[i] < obLow) {
        departure = i;
        break;
      }
    }
    if (departure < 0) {
      return null;
    }

    for (let i = departure + 1; i < candles.length; i++) {
      if (high[i] >= obLow) {
        return time[i];
      }
    }
    return null;
  }
}
