import { InitialBalanceDetector } from '../detectors/initial-balance.detector';
import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Pattern } from '../domain/pattern';
import { Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import {
  addMinutes,
  compareHourMinute,
  HourMinute,
  localWallTimeToUtcMs,
  minuteOfDay,
  parseHhMm,
} from '../domain/time/session';
import { ZoneOffsetTable } from '../domain/time/zone-offset-table';

export interface FrankfurtIb50Options {
  readonly sessionStart?: string;
  readonly sessionTz?: string;
  readonly ibDurationMinutes?: number;
  readonly sessionEnd?: string;
  readonly swingLength?: number;
  readonly timeframe?: string;
}

interface SessionState {
  entered: boolean;
  ib: Pattern | null;
}

/**
 * Frankfurt Initial Balance 50% breakout.
 *
 *  1. Compute the Frankfurt IB (08:00-09:00 Europe/Berlin, wick-based). Its
 *     midpoint is the trigger level.
 *  2. After the IB window closes, watch consecutive 1m closes. When they
 *     straddle the midpoint, enter in the direction of the newer close:
 *       prevClose <= mid <  currClose  -> long
 *       prevClose >= mid >  currClose  -> short
 *  3. Stop = nearest confirmed swing in the session, or the opposite IB edge.
 *  4. Target = a full IB projection: IB high + range (long), IB low - range.
 *  5. The trade expires at `sessionEnd` local, and there is one entry per
 *     session date.
 *
 * Unlike the detectors this strategy is STATEFUL: it remembers, per local
 * session date, whether it has already traded and what the IB was. The engine
 * hands it a fresh context each bar but the same strategy instance, which is
 * what makes that carry across bars.
 */
export class FrankfurtIb50Strategy extends Strategy {
  readonly name = 'frankfurt_ib_50';
  readonly version = '1.0';

  readonly sessionStart: string;
  readonly sessionTz: string;
  readonly ibDurationMinutes: number;
  readonly sessionEnd: string;
  readonly swingLength: number;
  readonly timeframe: string;

  private readonly startTime: HourMinute;
  private readonly ibEndTime: HourMinute;
  private readonly endTime: HourMinute;
  private readonly detector: InitialBalanceDetector;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: FrankfurtIb50Options = {}) {
    super();
    this.sessionStart = options.sessionStart ?? '08:00';
    this.sessionTz = options.sessionTz ?? 'Europe/Berlin';
    this.ibDurationMinutes = options.ibDurationMinutes ?? 60;
    this.sessionEnd = options.sessionEnd ?? '10:00';
    this.swingLength = options.swingLength ?? 3;
    this.timeframe = options.timeframe ?? '1m';

    this.startTime = parseHhMm(this.sessionStart);
    this.ibEndTime = addMinutes(this.startTime, this.ibDurationMinutes);
    this.endTime = parseHhMm(this.sessionEnd);

    if (
      !(
        compareHourMinute(this.startTime, this.ibEndTime) < 0 &&
        compareHourMinute(this.ibEndTime, this.endTime) <= 0
      )
    ) {
      throw new Error('Require sessionStart < ibEnd <= sessionEnd (same day)');
    }

    this.detector = new InitialBalanceDetector({
      sessionStart: this.sessionStart,
      sessionTz: this.sessionTz,
      durationMinutes: this.ibDurationMinutes,
      timeframe: this.timeframe,
    });
  }

  checkEntry(context: MarketContext): Signal | null {
    const candles = context.candles(this.timeframe);
    if (candles.length < 2) {
      return null;
    }

    const currentTime = candles.lastTime as number;
    const table = ZoneOffsetTable.forZone(this.sessionTz, candles.time[0], currentTime);
    const sessionDate = table.localDateKey(currentTime);
    const localMinute = table.localMinuteOfDay(currentTime);

    let state = this.sessions.get(sessionDate);
    if (state === undefined) {
      state = { entered: false, ib: null };
      this.sessions.set(sessionDate, state);
    }
    if (state.entered) {
      return null;
    }
    if (localMinute < minuteOfDay(this.ibEndTime) || localMinute >= minuteOfDay(this.endTime)) {
      return null;
    }

    if (state.ib === null) {
      state.ib = this.todaysInitialBalance(candles, sessionDate);
      if (state.ib === null) {
        return null;
      }
    }

    const ib = state.ib;
    const mid = ib.meta.mid as number;
    const previousClose = candles.close[candles.length - 2];
    const currentClose = candles.close[candles.length - 1];

    let direction: Direction;
    if (previousClose <= mid && mid < currentClose) {
      direction = Direction.Long;
    } else if (previousClose >= mid && mid > currentClose) {
      direction = Direction.Short;
    } else {
      return null;
    }

    let stopLoss: number;
    if (direction === Direction.Long) {
      const swing = this.nearestSwingLow(candles);
      // `x or y` in Python: a falsy swing (null here) falls back to the IB edge.
      stopLoss = swing ? swing : ib.low;
      if (stopLoss >= currentClose) {
        return null;
      }
    } else {
      const swing = this.nearestSwingHigh(candles);
      stopLoss = swing ? swing : ib.high;
      if (stopLoss <= currentClose) {
        return null;
      }
    }

    const ibRange = ib.high - ib.low;
    const takeProfit = direction === Direction.Long ? ib.high + ibRange : ib.low - ibRange;
    // A session end is a derived time, not parsed input: on the one day a year
    // it falls inside a daylight-saving gap, take the nearest real instant
    // rather than aborting the whole replay.
    const expiry = localWallTimeToUtcMs(table, sessionDate, this.endTime, {
      onNonexistent: 'shiftForward',
      onAmbiguous: 'earlier',
    });

    state.entered = true;

    return new Signal({
      symbol: context.symbol,
      direction,
      entry: currentClose,
      stopLoss,
      takeProfit,
      timeframe: this.timeframe,
      timestamp: currentTime,
      strategyName: this.name,
      strategyVersion: this.version,
      triggeredBy: ['frankfurt_ib', 'mid_cross'],
      meta: {
        ib_high: ib.high,
        ib_low: ib.low,
        ib_mid: mid,
        session_date: sessionDate,
      },
      expiryTime: expiry,
    });
  }

  private todaysInitialBalance(candles: CandleSeries, sessionDate: string): Pattern | null {
    for (const pattern of this.detector.detect(candles)) {
      if (pattern.meta.session_date === sessionDate) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Most recent confirmed swing low, scanning backwards.
   *
   * The scan starts `swingLength` bars back from the end because a pivot is
   * not confirmed until that many bars have closed after it.
   */
  private nearestSwingLow(candles: CandleSeries): number | null {
    const n = this.swingLength;
    const { low } = candles;

    for (let i = candles.length - 1 - n; i >= n; i--) {
      let leftMin = Infinity;
      for (let j = i - n; j < i; j++) {
        if (low[j] < leftMin) {
          leftMin = low[j];
        }
      }
      let rightMin = Infinity;
      for (let j = i + 1; j <= i + n; j++) {
        if (low[j] < rightMin) {
          rightMin = low[j];
        }
      }
      if (low[i] < leftMin && low[i] < rightMin) {
        return low[i];
      }
    }
    return null;
  }

  private nearestSwingHigh(candles: CandleSeries): number | null {
    const n = this.swingLength;
    const { high } = candles;

    for (let i = candles.length - 1 - n; i >= n; i--) {
      let leftMax = -Infinity;
      for (let j = i - n; j < i; j++) {
        if (high[j] > leftMax) {
          leftMax = high[j];
        }
      }
      let rightMax = -Infinity;
      for (let j = i + 1; j <= i + n; j++) {
        if (high[j] > rightMax) {
          rightMax = high[j];
        }
      }
      if (high[i] > leftMax && high[i] > rightMax) {
        return high[i];
      }
    }
    return null;
  }
}
