import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { sortByStartTime, swingHighIndices, swingLowIndices } from './swings';

export interface SnrOptions {
  readonly swingLength?: number;
  /** Cluster half-width as a fraction of price: 0.002 = 0.2%. */
  readonly tolerance?: number;
  readonly minTouches?: number;
  readonly timeframe?: string;
}

interface Touch {
  readonly index: number;
  readonly price: number;
}

/**
 * Support and resistance zones.
 *
 * Swing highs (resistance) and swing lows (support) whose prices sit within
 * `tolerance` of each other are clustered into a single price zone; a zone is
 * emitted once it has at least `minTouches` touches.
 *
 * A zone breaks when a candle CLOSES through it, checked from the bar after
 * the last touch that formed it: resistance on `close > high`, support on
 * `close < low`.
 *
 * meta: `side` ("support" | "resistance"), `touches`, `broken`.
 */
export class SnrDetector implements Detector {
  readonly swingLength: number;
  readonly tolerance: number;
  readonly minTouches: number;
  readonly timeframe: string;

  constructor(options: SnrOptions = {}) {
    this.swingLength = options.swingLength ?? 3;
    this.tolerance = options.tolerance ?? 0.002;
    this.minTouches = options.minTouches ?? 2;
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.length < this.swingLength * 2 + 1) {
      return [];
    }

    const patterns: Pattern[] = [];

    const resistanceTouches = swingHighIndices(candles, this.swingLength).map((index) => ({
      index,
      price: candles.high[index],
    }));
    for (const cluster of this.cluster(resistanceTouches)) {
      if (cluster.length >= this.minTouches) {
        patterns.push(this.makeZone(candles, cluster, 'resistance'));
      }
    }

    const supportTouches = swingLowIndices(candles, this.swingLength).map((index) => ({
      index,
      price: candles.low[index],
    }));
    for (const cluster of this.cluster(supportTouches)) {
      if (cluster.length >= this.minTouches) {
        patterns.push(this.makeZone(candles, cluster, 'support'));
      }
    }

    return sortByStartTime(patterns);
  }

  private makeZone(candles: CandleSeries, cluster: Touch[], side: string): Pattern {
    let zoneHigh = -Infinity;
    let zoneLow = Infinity;
    let firstIndex = Infinity;
    let lastIndex = -Infinity;

    for (const touch of cluster) {
      if (touch.price > zoneHigh) {
        zoneHigh = touch.price;
      }
      if (touch.price < zoneLow) {
        zoneLow = touch.price;
      }
      if (touch.index < firstIndex) {
        firstIndex = touch.index;
      }
      if (touch.index > lastIndex) {
        lastIndex = touch.index;
      }
    }

    const broken =
      side === 'resistance'
        ? this.breakAbove(candles, zoneHigh, lastIndex + 1)
        : this.breakBelow(candles, zoneLow, lastIndex + 1);

    return new Pattern({
      type: PatternType.Snr,
      timeframe: this.timeframe,
      startTime: candles.time[firstIndex],
      endTime: broken,
      high: zoneHigh,
      low: zoneLow,
      meta: { side, touches: cluster.length, broken: broken !== null },
    });
  }

  private breakAbove(candles: CandleSeries, zoneHigh: number, startIndex: number): number | null {
    const { close, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (close[i] > zoneHigh) {
        return time[i];
      }
    }
    return null;
  }

  private breakBelow(candles: CandleSeries, zoneLow: number, startIndex: number): number | null {
    const { close, time } = candles;
    for (let i = startIndex; i < candles.length; i++) {
      if (close[i] < zoneLow) {
        return time[i];
      }
    }
    return null;
  }

  /**
   * Greedy clustering over price-sorted levels.
   *
   * The cluster centre is the running mean, recomputed by summing the members
   * in insertion order. That summation order is load-bearing for parity:
   * Python 3.11's `sum()` accumulates naively, exactly like the reduce below,
   * whereas 3.12+ switched to compensated summation and would drift.
   */
  private cluster(levels: Touch[]): Touch[][] {
    if (levels.length === 0) {
      return [];
    }

    // Stable sort by price; ties keep the original swing order.
    const byPrice = [...levels].sort((a, b) => a.price - b.price);
    const clusters: Touch[][] = [[byPrice[0]]];

    for (let i = 1; i < byPrice.length; i++) {
      const touch = byPrice[i];
      const current = clusters[clusters.length - 1];

      let total = 0;
      for (const member of current) {
        total += member.price;
      }
      const center = total / current.length;

      if (Math.abs(touch.price - center) / center <= this.tolerance) {
        current.push(touch);
      } else {
        clusters.push([touch]);
      }
    }
    return clusters;
  }
}
