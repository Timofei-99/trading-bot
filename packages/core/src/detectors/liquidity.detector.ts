import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { sortByStartTime, swingHighIndices, swingLowIndices } from './swings';

export interface LiquidityOptions {
  readonly swingLength?: number;
  readonly timeframe?: string;
}

/**
 * Buy-side and sell-side liquidity levels (BSL / SSL).
 *
 * BSL rests above swing highs — stop-losses and limit buys price must grab
 * before it can reverse or continue. SSL rests below swing lows.
 *
 * The distinction from BOS/CHOCH: a liquidity SWEEP is triggered by a wick,
 * not a close. Price only has to touch through the level.
 *
 * `high === low === the level`: this is a horizontal line, not a zone.
 * `startTime` is the swing candle that created it, `endTime` the first candle
 * that swept it (null while intact).
 *
 * meta: `side` ("buy" | "sell"), `swept`.
 */
export class LiquidityDetector implements Detector {
  readonly swingLength: number;
  readonly timeframe: string;

  constructor(options: LiquidityOptions = {}) {
    this.swingLength = options.swingLength ?? 3;
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < this.swingLength * 2 + 1) {
      return [];
    }

    const patterns: Pattern[] = [];

    for (const index of swingHighIndices(candles, this.swingLength)) {
      patterns.push(this.buySideLiquidity(candles, index));
    }
    for (const index of swingLowIndices(candles, this.swingLength)) {
      patterns.push(this.sellSideLiquidity(candles, index));
    }

    return sortByStartTime(patterns);
  }

  private buySideLiquidity(candles: CandleSeries, swingIndex: number): Pattern {
    const price = candles.high[swingIndex];
    const swept = this.sweepHigh(candles, price, swingIndex + 1);
    return new Pattern({
      type: PatternType.Liquidity,
      timeframe: this.timeframe,
      startTime: candles.time[swingIndex],
      endTime: swept,
      high: price,
      low: price,
      meta: { side: 'buy', swept: swept !== null },
    });
  }

  private sellSideLiquidity(candles: CandleSeries, swingIndex: number): Pattern {
    const price = candles.low[swingIndex];
    const swept = this.sweepLow(candles, price, swingIndex + 1);
    return new Pattern({
      type: PatternType.Liquidity,
      timeframe: this.timeframe,
      startTime: candles.time[swingIndex],
      endTime: swept,
      high: price,
      low: price,
      meta: { side: 'sell', swept: swept !== null },
    });
  }

  private sweepHigh(candles: CandleSeries, price: number, startIndex: number): number | null {
    const { high, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (high[i] > price) {
        return time[i];
      }
    }
    return null;
  }

  private sweepLow(candles: CandleSeries, price: number, startIndex: number): number | null {
    const { low, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (low[i] < price) {
        return time[i];
      }
    }
    return null;
  }
}
