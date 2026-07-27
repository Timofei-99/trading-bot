import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { HourMinute, minuteOfDay, parseHhMm } from '../domain/time/session';
import { ZoneOffsetTable } from '../domain/time/zone-offset-table';

const MINUTES_PER_DAY = 24 * 60;

export interface InitialBalanceOptions {
  readonly sessionStart?: string;
  readonly sessionTz?: string;
  readonly durationMinutes?: number;
  readonly session?: string;
  readonly timeframe?: string;
}

/**
 * Session Initial Balance — the high, low and midpoint of the first N minutes
 * of a session window defined in LOCAL time.
 *
 * Default: the Frankfurt (FDAX) session, 08:00-09:00 Europe/Berlin, which
 * resolves to 07:00 UTC in winter and 06:00 UTC in summer on its own. That
 * daylight-saving shift is the whole reason the window is expressed locally
 * and why this detector goes through `ZoneOffsetTable` rather than UTC hours
 * like `KillzoneDetector`.
 *
 * One pattern per local calendar day that has at least one candle in the
 * window. `high` / `low` are wick-based.
 *
 * meta: `session`, `session_date` (`YYYY-MM-DD` local), `mid`,
 * `duration_minutes`.
 */
export class InitialBalanceDetector implements Detector {
  readonly sessionStart: string;
  readonly sessionTz: string;
  readonly durationMinutes: number;
  readonly session: string;
  readonly timeframe: string;

  private readonly start: HourMinute;

  constructor(options: InitialBalanceOptions = {}) {
    this.durationMinutes = options.durationMinutes ?? 60;
    if (this.durationMinutes <= 0) {
      throw new Error('duration_minutes must be positive');
    }
    this.sessionStart = options.sessionStart ?? '08:00';
    this.start = parseHhMm(this.sessionStart);
    this.sessionTz = options.sessionTz ?? 'Europe/Berlin';
    this.session = options.session ?? 'frankfurt';
    this.timeframe = options.timeframe ?? '';
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.isEmpty) {
      return [];
    }

    const startMinute = minuteOfDay(this.start);
    const endMinute = startMinute + this.durationMinutes;
    if (endMinute > MINUTES_PER_DAY) {
      throw new Error('Session window must not cross local midnight');
    }

    const table = ZoneOffsetTable.forZone(
      this.sessionTz,
      candles.time[0],
      candles.time[candles.length - 1],
    );

    const { time, high, low } = candles;
    const byDay = new Map<string, number[]>();

    for (let i = 0; i < candles.length; i++) {
      const localMinute = table.localMinuteOfDay(time[i]);
      if (localMinute < startMinute || localMinute >= endMinute) {
        continue;
      }
      const day = table.localDateKey(time[i]);
      const bucket = byDay.get(day);
      if (bucket === undefined) {
        byDay.set(day, [i]);
      } else {
        bucket.push(i);
      }
    }

    const patterns: Pattern[] = [];
    // `YYYY-MM-DD` sorts lexicographically in chronological order.
    for (const day of [...byDay.keys()].sort()) {
      const indices = byDay.get(day) as number[];

      let sessionHigh = -Infinity;
      let sessionLow = Infinity;
      for (const i of indices) {
        if (high[i] > sessionHigh) {
          sessionHigh = high[i];
        }
        if (low[i] < sessionLow) {
          sessionLow = low[i];
        }
      }

      patterns.push(
        new Pattern({
          type: PatternType.InitialBalance,
          timeframe: this.timeframe,
          startTime: time[indices[0]],
          endTime: time[indices[indices.length - 1]],
          high: sessionHigh,
          low: sessionLow,
          meta: {
            session: this.session,
            session_date: day,
            mid: (sessionHigh + sessionLow) / 2,
            duration_minutes: this.durationMinutes,
          },
        }),
      );
    }

    return patterns;
  }
}
