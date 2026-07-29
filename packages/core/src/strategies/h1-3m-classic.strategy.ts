import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import { rawFractals, Sweep } from './h1-3m-fractals';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface H1m3mClassicOptions {
  readonly htf?: string;
  readonly ltf?: string;
  readonly symbol?: string;
  readonly minRr?: number;
  readonly maxStopPips?: number;
  readonly pipSize?: number;
  readonly fractalLookbackDays?: number;
  readonly contextThresholdPips?: number;
}

type MarketBias = 'BULLISH' | 'BEARISH' | 'RANGE';

/** Floor to the start of the UTC day, the port of `Timestamp.normalize()`. */
const utcDayStart = (timeMs: number): number => Math.floor(timeMs / DAY_MS) * DAY_MS;

const utcHour = (timeMs: number): number =>
  Math.floor((((timeMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);

const utcDateKey = (timeMs: number): string =>
  new Date(utcDayStart(timeMs)).toISOString().slice(0, 10);

/**
 * Which side swept most recently — the order-flow half of the daily bias.
 *
 * A `null` means that kind of sweep has not happened at all today, which is
 * why it reads as "infinitely long ago" rather than as zero: a bull sweep at
 * epoch 0 would otherwise lose to a bear sweep that never occurred.
 *
 * With no sweeps on either side there is nothing to read, so the caller's own
 * directional drift stands.
 */
export function orderFlowIsBullish(
  lastBullSweep: number | null,
  lastBearSweep: number | null,
  directionUp: boolean,
): boolean {
  if (lastBullSweep === null && lastBearSweep === null) {
    return directionUp;
  }
  return (lastBullSweep ?? -Infinity) > (lastBearSweep ?? -Infinity);
}

/**
 * 1h3m Classic — 1h context, 1h fractal sweep, 5m break of structure.
 *
 *  1. CONTEXT (1h, last 48 bars): a net directional drift plus matching order
 *     flow, where order flow is the direction of the most recently swept
 *     fractal. Disagreement means RANGE and no trading that day.
 *  2. FRACTAL SWEEP during the 06:00-09:00 UTC window: a 1h bar wicks through
 *     a fractal opposite to the context and closes back on the right side of
 *     it — a liquidity grab.
 *  3. 5m BOS: a 5m bar closes beyond the pre-sweep session extreme. Entry is
 *     at that close.
 *
 * Risk: stop at the sweep bar's wick, target at the previous day's high/low,
 * falling back to `minRr` when that target is too close. The setup is skipped
 * when the stop is wider than `maxStopPips`, when the reward would be below
 * `minRr`, or when the target has already been swept today. One signal per
 * UTC day.
 *
 * Like the Frankfurt strategy this one is stateful, and its state is keyed by
 * UTC calendar day rather than a local session.
 */
export class H1m3mClassicStrategy extends Strategy {
  readonly name = '1h3m_classic';
  readonly version = '1.0';

  /** Entry window in UTC: 09:00-12:00 Moscow. */
  private static readonly ENTRY_START_UTC = 6;
  private static readonly ENTRY_END_UTC = 9;

  readonly htf: string;
  readonly ltf: string;
  readonly symbol: string;
  readonly minRr: number;
  readonly maxStopPips: number;
  readonly pipSize: number;
  readonly fractalLookbackDays: number;
  readonly contextThresholdPips: number;

  private today: string | null = null;
  private bias: MarketBias | null = null;
  private previousDayHigh: number | null = null;
  private previousDayLow: number | null = null;
  private signalToday = false;
  private lastHtfBar: number | null = null;
  private sweep: Sweep | null = null;

  constructor(options: H1m3mClassicOptions = {}) {
    super();
    this.htf = options.htf ?? '1h';
    this.ltf = options.ltf ?? '5m';
    this.symbol = options.symbol ?? 'EURUSD=X';
    this.minRr = options.minRr ?? 1.3;
    this.maxStopPips = options.maxStopPips ?? 300;
    this.pipSize = options.pipSize ?? 0.0001;
    this.fractalLookbackDays = options.fractalLookbackDays ?? 1;
    this.contextThresholdPips = options.contextThresholdPips ?? 10;
  }

  checkEntry(context: MarketContext): Signal | null {
    const ltf = context.candles(this.ltf);
    const htf = context.candles(this.htf);
    if (ltf.isEmpty || htf.isEmpty || htf.length < 3) {
      return null;
    }

    const currentTime = ltf.lastTime as number;
    const currentDate = utcDateKey(currentTime);

    if (currentDate !== this.today) {
      this.resetDay(currentDate, htf, currentTime);
    }

    if (this.bias === 'RANGE' || this.bias === null) {
      return null;
    }
    if (this.signalToday) {
      return null;
    }

    const hour = utcHour(currentTime);
    const inWindow =
      hour >= H1m3mClassicStrategy.ENTRY_START_UTC && hour < H1m3mClassicStrategy.ENTRY_END_UTC;

    if (!inWindow) {
      // A pending sweep does not survive past the window.
      if (hour >= H1m3mClassicStrategy.ENTRY_END_UTC) {
        this.sweep = null;
      }
      return null;
    }

    const htfLastTime = htf.lastTime as number;
    if (htfLastTime !== this.lastHtfBar && this.sweep === null) {
      this.lastHtfBar = htfLastTime;
      const htfHour = utcHour(htfLastTime);
      // The 1h bar must have opened inside the widened detection window.
      if (
        htfHour >= H1m3mClassicStrategy.ENTRY_START_UTC - 1 &&
        htfHour < H1m3mClassicStrategy.ENTRY_END_UTC
      ) {
        const sweep = this.detectFractalSweep(htf, ltf, currentTime);
        if (sweep !== null) {
          this.sweep = sweep;
        }
      }
    }

    if (this.sweep === null) {
      return null;
    }
    return this.checkBreakOfStructure(ltf, currentTime);
  }

  // -------------------------------------------------------------------------

  private resetDay(day: string, htf: CandleSeries, currentTime: number): void {
    this.today = day;
    this.signalToday = false;
    this.sweep = null;
    this.lastHtfBar = null;

    const todayStart = utcDayStart(currentTime);
    const yesterdayStart = todayStart - DAY_MS;

    const previous = htf.slice(
      htf.searchSortedLeft(yesterdayStart),
      htf.searchSortedLeft(todayStart),
    );
    if (previous.isEmpty) {
      this.previousDayHigh = null;
      this.previousDayLow = null;
    } else {
      let high = -Infinity;
      let low = Infinity;
      for (let i = 0; i < previous.length; i++) {
        if (previous.high[i] > high) {
          high = previous.high[i];
        }
        if (previous.low[i] < low) {
          low = previous.low[i];
        }
      }
      this.previousDayHigh = high;
      this.previousDayLow = low;
    }

    this.bias = this.computeContext(htf, currentTime);
  }

  /**
   * Direction over the last 48 hours, cross-checked against order flow.
   *
   * Price drift alone is not enough: the most recent liquidity sweep has to
   * agree with it, otherwise the day is RANGE.
   */
  private computeContext(htf: CandleSeries, currentTime: number): MarketBias {
    const cutoff = currentTime - 48 * HOUR_MS;
    const recent = htf.slice(htf.searchSortedLeft(cutoff), htf.length);

    if (recent.length < 10) {
      return 'RANGE';
    }

    const netMove = recent.close[recent.length - 1] - recent.close[0];
    const threshold = this.contextThresholdPips * this.pipSize;
    if (Math.abs(netMove) < threshold) {
      return 'RANGE';
    }
    const directionUp = netMove > 0;

    let lastBullSweep: number | null = null;
    let lastBearSweep: number | null = null;

    for (const fractal of rawFractals(htf)) {
      if (fractal.confirmedAt < cutoff) {
        continue;
      }
      const level = fractal.level;
      const start = htf.searchSortedRight(fractal.barTime);

      for (let i = start; i < htf.length; i++) {
        if (htf.time[i] >= currentTime) {
          break;
        }
        if (fractal.type === 'low' && htf.low[i] < level && htf.close[i] > level) {
          if (lastBullSweep === null || htf.time[i] > lastBullSweep) {
            lastBullSweep = htf.time[i];
          }
          break;
        }
        if (fractal.type === 'high' && htf.high[i] > level && htf.close[i] < level) {
          if (lastBearSweep === null || htf.time[i] > lastBearSweep) {
            lastBearSweep = htf.time[i];
          }
          break;
        }
      }
    }

    const orderFlowBullish = orderFlowIsBullish(lastBullSweep, lastBearSweep, directionUp);

    if (directionUp && orderFlowBullish) {
      return 'BULLISH';
    }
    if (!directionUp && !orderFlowBullish) {
      return 'BEARISH';
    }
    return 'RANGE';
  }

  /** Did the latest 1h bar sweep a fractal in the context's direction? */
  private detectFractalSweep(
    htf: CandleSeries,
    ltf: CandleSeries,
    currentTime: number,
  ): Sweep | null {
    const lastIndex = htf.length - 1;
    const lastBarTime = htf.time[lastIndex];
    const todayStart = utcDayStart(currentTime);
    const lookback = todayStart - (this.fractalLookbackDays + 1) * DAY_MS;

    const fractals = rawFractals(htf);
    const targetType = this.bias === 'BULLISH' ? 'low' : 'high';

    // Most recent fractal first.
    for (let f = fractals.length - 1; f >= 0; f--) {
      const fractal = fractals[f];
      if (fractal.type !== targetType) {
        continue;
      }
      if (fractal.barTime >= lastBarTime) {
        continue; // the fractal must pre-date the sweep bar
      }
      if (fractal.confirmedAt < lookback) {
        continue; // only recent fractals
      }

      const level = fractal.level;

      if (targetType === 'low') {
        // Invalidation: if any bar between confirmation and the sweep bar
        // already CLOSED below the level, it was broken rather than swept.
        // The rule is long-only — for shorts a bar closing above the high is
        // the Frankfurt manipulation pattern and stays valid.
        const from = htf.searchSortedRight(fractal.confirmedAt);
        const to = htf.searchSortedLeft(lastBarTime);
        let broken = false;
        for (let i = from; i < to; i++) {
          if (htf.close[i] < level) {
            broken = true;
            break;
          }
        }
        if (broken) {
          continue; // try the next, older fractal
        }
      }

      const swept =
        targetType === 'low'
          ? htf.low[lastIndex] < level && htf.close[lastIndex] > level
          : htf.high[lastIndex] > level && htf.close[lastIndex] < level;

      if (!swept) {
        continue;
      }

      // Pre-sweep reference: the session extreme of the 5m bars so far today.
      const sessionOpen = todayStart + (H1m3mClassicStrategy.ENTRY_START_UTC - 1) * HOUR_MS;
      const session = ltf.slice(
        ltf.searchSortedLeft(sessionOpen),
        ltf.searchSortedRight(lastBarTime),
      );

      if (targetType === 'low') {
        let preSweepRef = htf.close[lastIndex];
        if (!session.isEmpty) {
          preSweepRef = -Infinity;
          for (let i = 0; i < session.length; i++) {
            if (session.high[i] > preSweepRef) {
              preSweepRef = session.high[i];
            }
          }
        }
        return {
          direction: 'LONG',
          stopLevel: htf.low[lastIndex],
          fractalLevel: level,
          preSweepRef,
        };
      }

      let preSweepRef = htf.close[lastIndex];
      if (!session.isEmpty) {
        preSweepRef = Infinity;
        for (let i = 0; i < session.length; i++) {
          if (session.low[i] < preSweepRef) {
            preSweepRef = session.low[i];
          }
        }
      }
      return {
        direction: 'SHORT',
        stopLevel: htf.high[lastIndex],
        fractalLevel: level,
        preSweepRef,
      };
    }

    return null;
  }

  private checkBreakOfStructure(ltf: CandleSeries, currentTime: number): Signal | null {
    const sweep = this.sweep as Sweep;
    const currentClose = ltf.close[ltf.length - 1];

    const bosLong = sweep.direction === 'LONG' && currentClose > sweep.preSweepRef;
    const bosShort = sweep.direction === 'SHORT' && currentClose < sweep.preSweepRef;
    if (!bosLong && !bosShort) {
      return null;
    }

    return this.buildSignal(
      currentClose,
      sweep,
      currentTime,
      bosLong ? Direction.Long : Direction.Short,
      ltf,
    );
  }

  private buildSignal(
    entry: number,
    sweep: Sweep,
    currentTime: number,
    direction: Direction,
    ltf: CandleSeries,
  ): Signal | null {
    const stop = sweep.stopLevel;
    const maxStop = this.maxStopPips * this.pipSize;
    const todayStart = utcDayStart(currentTime);
    let takeProfit: number;

    if (direction === Direction.Long) {
      const risk = entry - stop;
      if (risk <= 0 || risk > maxStop) {
        return null;
      }

      if (this.previousDayHigh !== null) {
        const today = ltf.slice(ltf.searchSortedLeft(todayStart), ltf.length);
        if (!today.isEmpty) {
          let high = -Infinity;
          for (let i = 0; i < today.length; i++) {
            if (today.high[i] > high) {
              high = today.high[i];
            }
          }
          if (high >= this.previousDayHigh) {
            return null; // the target has already been taken today
          }
        }
      }

      if (this.previousDayHigh !== null && this.previousDayHigh > entry) {
        const reward = this.previousDayHigh - entry;
        takeProfit = reward / risk >= this.minRr ? this.previousDayHigh : entry + risk * this.minRr;
      } else {
        takeProfit = entry + risk * this.minRr;
      }
    } else {
      const risk = stop - entry;
      if (risk <= 0 || risk > maxStop) {
        return null;
      }

      if (this.previousDayLow !== null) {
        const today = ltf.slice(ltf.searchSortedLeft(todayStart), ltf.length);
        if (!today.isEmpty) {
          let low = Infinity;
          for (let i = 0; i < today.length; i++) {
            if (today.low[i] < low) {
              low = today.low[i];
            }
          }
          if (low <= this.previousDayLow) {
            return null;
          }
        }
      }

      if (this.previousDayLow !== null && this.previousDayLow < entry) {
        const reward = entry - this.previousDayLow;
        takeProfit = reward / risk >= this.minRr ? this.previousDayLow : entry - risk * this.minRr;
      } else {
        takeProfit = entry - risk * this.minRr;
      }
    }

    this.signalToday = true;
    this.sweep = null;

    return new Signal({
      symbol: this.symbol,
      direction,
      entry,
      stopLoss: stop,
      takeProfit,
      timeframe: this.ltf,
      timestamp: currentTime,
      strategyName: this.name,
      strategyVersion: this.version,
      triggeredBy: ['1h_fractal_sweep', '5m_bos'],
      meta: {
        context: this.bias,
        fractal_level: sweep.fractalLevel,
        pre_sweep_ref: sweep.preSweepRef,
        pdh: this.previousDayHigh,
        pdl: this.previousDayLow,
      },
    });
  }
}
