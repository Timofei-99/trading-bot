import { InitialBalanceDetector } from '../detectors/initial-balance.detector';
import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Pattern } from '../domain/pattern';
import { Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import {
  compareHourMinute,
  HourMinute,
  localWallTimeToUtcMs,
  minuteOfDay,
  parseHhMm,
} from '../domain/time/session';
import { ZoneOffsetTable } from '../domain/time/zone-offset-table';

export interface FrankfurtIb50Options {
  readonly ibStart?: string;
  readonly ibEnd?: string;
  readonly sessionEnd?: string;
  readonly sessionTz?: string;
  readonly timeframe?: string;
}

interface SessionState {
  entered: boolean;
  ib: Pattern | null;
}

/**
 * Frankfurt Initial Balance breakout into London.
 *
 *  1. Frankfurt IB window: ibStart–ibEnd local time (default 08:00–09:00 UTC).
 *     IB high and low are wick-based; the midpoint is metadata only.
 *  2. London entry window: ibEnd–sessionEnd.  Watch consecutive 1m closes:
 *       currClose > IB high  -> long  (stop at IB low,  TP at 1:1 from IB low)
 *       currClose < IB low   -> short (stop at IB high, TP at 1:1 from IB high)
 *  3. First breakout of the session is taken; one trade per day.
 *  4. All fills are at market (current close), RR is always 1:1.
 */
export class FrankfurtIb50Strategy extends Strategy {
  readonly name = 'frankfurt_ib_50';
  readonly version = '2.0';

  readonly ibStart: string;
  readonly ibEnd: string;
  readonly sessionEnd: string;
  readonly sessionTz: string;
  readonly timeframe: string;

  private readonly ibStartTime: HourMinute;
  private readonly ibEndTime: HourMinute;
  private readonly endTime: HourMinute;
  private readonly detector: InitialBalanceDetector;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: FrankfurtIb50Options = {}) {
    super();
    this.ibStart = options.ibStart ?? '08:00';
    this.ibEnd = options.ibEnd ?? '09:00';
    this.sessionEnd = options.sessionEnd ?? '12:00';
    this.sessionTz = options.sessionTz ?? 'UTC';
    this.timeframe = options.timeframe ?? '1m';

    this.ibStartTime = parseHhMm(this.ibStart);
    this.ibEndTime = parseHhMm(this.ibEnd);
    this.endTime = parseHhMm(this.sessionEnd);

    if (!(
      compareHourMinute(this.ibStartTime, this.ibEndTime) < 0 &&
      compareHourMinute(this.ibEndTime, this.endTime) <= 0
    )) {
      throw new Error('Require ibStart < ibEnd <= sessionEnd (same day)');
    }

    this.detector = new InitialBalanceDetector({
      sessionStart: this.ibStart,
      sessionTz: this.sessionTz,
      durationMinutes: minuteOfDay(this.ibEndTime) - minuteOfDay(this.ibStartTime),
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

    // Entry window: [ibEnd, sessionEnd)
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
    const currentClose = candles.close[candles.length - 1];

    let direction: Direction;
    let stopLoss: number;

    if (currentClose > ib.high) {
      direction = Direction.Long;
      stopLoss = ib.low;
    } else if (currentClose < ib.low) {
      direction = Direction.Short;
      stopLoss = ib.high;
    } else {
      return null;
    }

    const risk = Math.abs(currentClose - stopLoss);
    const takeProfit = direction === Direction.Long ? currentClose + risk : currentClose - risk;

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
      triggeredBy: ['frankfurt_ib', 'breakout'],
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
}
