import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';

export interface FractalOptions {
  readonly timeframe?: string;
}

/**
 * 3-candle swing fractals.
 *
 * Fractal HIGH at bar i: `high[i] > high[i-1]` and `high[i] > high[i+1]`.
 * Fractal LOW  at bar i: `low[i]  < low[i-1]`  and `low[i]  < low[i+1]`.
 *
 * The fractal is CONFIRMED when bar `i+1` closes, which is what `endTime`
 * records. The last two bars of any slice therefore can never carry a
 * confirmed fractal — that is what makes the detector safe on a rolling
 * window.
 *
 * meta: `fractal_type` ("high" | "low"), `level`.
 */
export class FractalDetector implements Detector {
  readonly timeframe: string;

  constructor(options: FractalOptions = {}) {
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < 3) {
      return [];
    }

    const { high, low, time } = candles;
    const patterns: Pattern[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      if (high[i] > high[i - 1] && high[i] > high[i + 1]) {
        const level = high[i];
        patterns.push(
          new Pattern({
            type: PatternType.Fractal,
            timeframe: this.timeframe,
            startTime: time[i],
            endTime: time[i + 1],
            high: level,
            low: level,
            meta: { fractal_type: 'high', level },
          }),
        );
      }

      if (low[i] < low[i - 1] && low[i] < low[i + 1]) {
        const level = low[i];
        patterns.push(
          new Pattern({
            type: PatternType.Fractal,
            timeframe: this.timeframe,
            startTime: time[i],
            endTime: time[i + 1],
            high: level,
            low: level,
            meta: { fractal_type: 'low', level },
          }),
        );
      }
    }

    return patterns;
  }
}
