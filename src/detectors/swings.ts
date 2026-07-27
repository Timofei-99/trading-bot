import { CandleSeries } from '../domain/candle-series';

/**
 * Swing pivot detection, shared by every structural detector.
 *
 * The Python code repeated these two loops verbatim inside `OrderBlockDetector`,
 * `LiquidityDetector`, `StructureDetector`, `PremiumDiscountDetector` and
 * `SNRDetector`. Same algorithm, five copies — hoisted here unchanged.
 *
 * A pivot is STRICT: the bar must beat all `swingLength` neighbours on both
 * sides, so an equal neighbour disqualifies it. Bars closer than `swingLength`
 * to either edge can never be pivots, which is also what keeps the detectors
 * free of look-ahead bias when they run on a rolling window: a pivot only
 * appears once the bars that confirm it have closed.
 */

export function swingHighIndices(candles: CandleSeries, swingLength: number): number[] {
  const { high } = candles;
  const n = swingLength;
  const result: number[] = [];

  for (let i = n; i < candles.length - n; i++) {
    const pivot = high[i];

    let leftMax = -Infinity;
    for (let j = i - n; j < i; j++) {
      if (high[j] > leftMax) {
        leftMax = high[j];
      }
    }
    if (!(pivot > leftMax)) {
      continue;
    }

    let rightMax = -Infinity;
    for (let j = i + 1; j <= i + n; j++) {
      if (high[j] > rightMax) {
        rightMax = high[j];
      }
    }
    if (pivot > rightMax) {
      result.push(i);
    }
  }
  return result;
}

export function swingLowIndices(candles: CandleSeries, swingLength: number): number[] {
  const { low } = candles;
  const n = swingLength;
  const result: number[] = [];

  for (let i = n; i < candles.length - n; i++) {
    const pivot = low[i];

    let leftMin = Infinity;
    for (let j = i - n; j < i; j++) {
      if (low[j] < leftMin) {
        leftMin = low[j];
      }
    }
    if (!(pivot < leftMin)) {
      continue;
    }

    let rightMin = Infinity;
    for (let j = i + 1; j <= i + n; j++) {
      if (low[j] < rightMin) {
        rightMin = low[j];
      }
    }
    if (pivot < rightMin) {
      result.push(i);
    }
  }
  return result;
}

/**
 * Stable sort by `startTime`.
 *
 * Detectors emit one family of patterns then another (bullish order blocks
 * before bearish, BSL before SSL, premium before discount) and then sort. The
 * sort must be stable or patterns sharing a timestamp would swap places
 * against the golden fixtures — `list.sort` in Python and `Array#sort` in
 * modern JS both guarantee it.
 */
export function sortByStartTime<T extends { startTime: number }>(patterns: T[]): T[] {
  patterns.sort((a, b) => a.startTime - b.startTime);
  return patterns;
}
