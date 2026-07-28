import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';

export interface FvgOptions {
  readonly timeframe?: string;
  /** Minimum gap size in price units; smaller imbalances are ignored. */
  readonly minGap?: number;
}

/**
 * Fair Value Gaps — 3-candle imbalances.
 *
 * A Fair Value Gap is an area price moved through so fast that it left an
 * unfilled gap between candle 1 and candle 3, with candle 2 as the impulse.
 *
 * Bullish FVG: `C[i-1].high < C[i+1].low`
 *     Zone = [C[i-1].high, C[i+1].low]   (`low`, `high`)
 *     Mitigated when a later candle's LOW reaches back down to `high`.
 *
 * Bearish FVG: `C[i+1].high < C[i-1].low`
 *     Zone = [C[i+1].high, C[i-1].low]
 *     Mitigated when a later candle's HIGH reaches back up to `low`.
 *
 * Mitigation is single-phase: any candle touching the boundary after candle 3
 * closes counts, because the gap is confirmed and price has by definition
 * already left the zone.
 *
 * `startTime` is candle 1, `endTime` the first mitigating candle (or null),
 * and `mid` the 50% equilibrium of the gap.
 *
 * meta: `direction` ("bullish" | "bearish"), `impulse_time` (epoch ms of
 * candle 2), `gap_size`, `mitigated`.
 */
export class FvgDetector implements Detector {
  readonly timeframe: string;
  readonly minGap: number;

  constructor(options: FvgOptions = {}) {
    this.timeframe = options.timeframe ?? '';
    this.minGap = options.minGap ?? 0;
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < 3) {
      return [];
    }

    const { high, low, time } = candles;
    const patterns: Pattern[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      const c1High = high[i - 1];
      const c1Low = low[i - 1];
      const c3High = high[i + 1];
      const c3Low = low[i + 1];

      if (c3Low > c1High) {
        const gap = c3Low - c1High;
        if (gap < this.minGap) {
          continue;
        }
        const fvgLow = c1High;
        const fvgHigh = c3Low;
        const mitigated = this.mitigationBullish(candles, fvgHigh, i + 2);
        patterns.push(
          new Pattern({
            type: PatternType.Fvg,
            timeframe: this.timeframe,
            startTime: time[i - 1],
            endTime: mitigated,
            high: fvgHigh,
            low: fvgLow,
            meta: {
              direction: 'bullish',
              impulse_time: time[i],
              gap_size: gap,
              mitigated: mitigated !== null,
            },
          }),
        );
      } else if (c3High < c1Low) {
        const gap = c1Low - c3High;
        if (gap < this.minGap) {
          continue;
        }
        const fvgLow = c3High;
        const fvgHigh = c1Low;
        const mitigated = this.mitigationBearish(candles, fvgLow, i + 2);
        patterns.push(
          new Pattern({
            type: PatternType.Fvg,
            timeframe: this.timeframe,
            startTime: time[i - 1],
            endTime: mitigated,
            high: fvgHigh,
            low: fvgLow,
            meta: {
              direction: 'bearish',
              impulse_time: time[i],
              gap_size: gap,
              mitigated: mitigated !== null,
            },
          }),
        );
      }
    }

    return patterns;
  }

  private mitigationBullish(
    candles: CandleSeries,
    fvgHigh: number,
    startIndex: number,
  ): number | null {
    const { low, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (low[i] <= fvgHigh) {
        return time[i];
      }
    }
    return null;
  }

  private mitigationBearish(
    candles: CandleSeries,
    fvgLow: number,
    startIndex: number,
  ): number | null {
    const { high, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (high[i] >= fvgLow) {
        return time[i];
      }
    }
    return null;
  }
}
