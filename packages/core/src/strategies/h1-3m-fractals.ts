import { CandleSeries } from '../domain/candle-series';

/**
 * Fractal geometry for the 1h3m strategy.
 *
 * Split out because it is pure shape-of-the-bars reasoning with no opinion
 * about sessions, risk or entries — and because it is the part of the strategy
 * whose branches were hardest to reach through the strategy's own front door.
 *
 * Parity-pinned: every number here is compared bit-for-bit against the Python
 * original, so this file moved verbatim rather than being rewritten.
 */

export interface RawFractal {
  readonly type: 'high' | 'low';
  readonly level: number;
  readonly barTime: number;
  readonly confirmedAt: number;
}

export interface Sweep {
  readonly direction: 'LONG' | 'SHORT';
  readonly stopLevel: number;
  readonly fractalLevel: number;
  readonly preSweepRef: number;
}

export function rawFractals(candles: CandleSeries): RawFractal[] {
  const { high, low, time } = candles;
  const out: RawFractal[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    if (high[i] > high[i - 1] && high[i] > high[i + 1]) {
      out.push({ type: 'high', level: high[i], barTime: time[i], confirmedAt: time[i + 1] });
    }
    if (low[i] < low[i - 1] && low[i] < low[i + 1]) {
      out.push({ type: 'low', level: low[i], barTime: time[i], confirmedAt: time[i + 1] });
    }
  }
  return out;
}
