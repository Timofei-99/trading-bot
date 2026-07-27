import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { swingHighIndices, swingLowIndices } from './swings';

export interface StructureOptions {
  readonly swingLength?: number;
  readonly timeframe?: string;
}

/**
 * Break of Structure (BOS) and Change of Character (CHOCH).
 *
 * BOS   — price closes beyond a confirmed swing level *with* the current
 *         trend: continuation.
 * CHOCH — price closes beyond a confirmed swing level *against* it: a
 *         potential reversal. The first structural break of a series, when no
 *         trend is established yet, is always a CHOCH.
 *
 * A pivot at bar `j` only becomes usable once `swingLength` bars have closed
 * to its right, i.e. from bar `j + swingLength + 1` onward — the same rule
 * that keeps the detector honest on a rolling window.
 *
 * A level is consumed by the break that takes it out, so the scan then waits
 * for the next pivot on that side.
 *
 * meta: `direction`, `broken_level`.
 */
export class StructureDetector implements Detector {
  readonly swingLength: number;
  readonly timeframe: string;

  constructor(options: StructureOptions = {}) {
    this.swingLength = options.swingLength ?? 3;
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    const minBars = this.swingLength * 2 + 2;
    if (candles.length < minBars) {
      return [];
    }

    const swingHighs = swingHighIndices(candles, this.swingLength);
    const swingLows = swingLowIndices(candles, this.swingLength);

    const { time, close, high, low } = candles;
    const n = this.swingLength;
    const patterns: Pattern[] = [];

    let highPointer = 0;
    let lowPointer = 0;
    let currentHigh: number | null = null;
    let currentLow: number | null = null;
    let trend: 'bullish' | 'bearish' | null = null;

    for (let i = 0; i < candles.length; i++) {
      while (highPointer < swingHighs.length && swingHighs[highPointer] + n < i) {
        currentHigh = swingHighs[highPointer];
        highPointer += 1;
      }
      while (lowPointer < swingLows.length && swingLows[lowPointer] + n < i) {
        currentLow = swingLows[lowPointer];
        lowPointer += 1;
      }

      if (currentHigh === null || currentLow === null) {
        continue;
      }

      const barClose = close[i];
      const highPrice = high[currentHigh];
      const lowPrice = low[currentLow];

      if (barClose > highPrice) {
        patterns.push(
          new Pattern({
            type: trend === 'bullish' ? PatternType.Bos : PatternType.Choch,
            timeframe: this.timeframe,
            startTime: time[currentHigh],
            endTime: time[i],
            high: highPrice,
            low: highPrice,
            meta: { direction: 'bullish', broken_level: highPrice },
          }),
        );
        trend = 'bullish';
        currentHigh = null;
      } else if (barClose < lowPrice) {
        patterns.push(
          new Pattern({
            type: trend === 'bearish' ? PatternType.Bos : PatternType.Choch,
            timeframe: this.timeframe,
            startTime: time[currentLow],
            endTime: time[i],
            high: lowPrice,
            low: lowPrice,
            meta: { direction: 'bearish', broken_level: lowPrice },
          }),
        );
        trend = 'bearish';
        currentLow = null;
      }
    }

    return patterns;
  }
}
