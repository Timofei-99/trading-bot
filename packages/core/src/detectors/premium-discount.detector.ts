import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { sortByStartTime, swingHighIndices, swingLowIndices } from './swings';

export interface PremiumDiscountOptions {
  readonly swingLength?: number;
  readonly timeframe?: string;
}

type SwingKind = 'high' | 'low';

/**
 * Premium and discount zones from swing-based dealing ranges.
 *
 * Each consecutive *alternating* pair of swing points (SL→SH or SH→SL) defines
 * a dealing range and yields two patterns:
 *
 *   premium  — upper half [equilibrium, range_high]: price is expensive here.
 *   discount — lower half [range_low, equilibrium]:  price is cheap here.
 *
 * `startTime` is the later of the two swing candles — the moment the range
 * became fully formed. `endTime` is null: zones do not expire on their own.
 *
 * meta: `zone`, `direction` ("bullish" when the low came first), `range_high`,
 * `range_low`, `equilibrium`.
 */
export class PremiumDiscountDetector implements Detector {
  readonly swingLength: number;
  readonly timeframe: string;

  constructor(options: PremiumDiscountOptions = {}) {
    this.swingLength = options.swingLength ?? 3;
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < this.swingLength * 2 + 1) {
      return [];
    }

    const swingHighs = swingHighIndices(candles, this.swingLength);
    const swingLows = swingLowIndices(candles, this.swingLength);
    if (swingHighs.length === 0 || swingLows.length === 0) {
      return [];
    }

    // Highs are listed before lows, then stable-sorted by bar index. An outside
    // bar can be both a swing high and a swing low; the stable sort is what
    // keeps "high" ahead of "low" for that shared index.
    const swings: { kind: SwingKind; index: number }[] = [
      ...swingHighs.map((index) => ({ kind: 'high' as SwingKind, index })),
      ...swingLows.map((index) => ({ kind: 'low' as SwingKind, index })),
    ];
    swings.sort((a, b) => a.index - b.index);

    const { high, low, time } = candles;
    const patterns: Pattern[] = [];

    for (let k = 0; k < swings.length - 1; k++) {
      const first = swings[k];
      const second = swings[k + 1];
      if (first.kind === second.kind) {
        continue; // two highs or two lows in a row: no range yet
      }

      let rangeHigh: number;
      let rangeLow: number;
      let direction: string;
      if (first.kind === 'low') {
        rangeLow = low[first.index];
        rangeHigh = high[second.index];
        direction = 'bullish';
      } else {
        rangeHigh = high[first.index];
        rangeLow = low[second.index];
        direction = 'bearish';
      }

      if (rangeLow >= rangeHigh) {
        continue; // degenerate range
      }

      const equilibrium = (rangeHigh + rangeLow) / 2;
      const startTime = time[Math.max(first.index, second.index)];
      const common = {
        direction,
        range_high: rangeHigh,
        range_low: rangeLow,
        equilibrium,
      };

      patterns.push(
        new Pattern({
          type: PatternType.PremiumDiscount,
          timeframe: this.timeframe,
          startTime,
          endTime: null,
          high: rangeHigh,
          low: equilibrium,
          meta: { zone: 'premium', ...common },
        }),
      );
      patterns.push(
        new Pattern({
          type: PatternType.PremiumDiscount,
          timeframe: this.timeframe,
          startTime,
          endTime: null,
          high: equilibrium,
          low: rangeLow,
          meta: { zone: 'discount', ...common },
        }),
      );
    }

    return sortByStartTime(patterns);
  }
}
