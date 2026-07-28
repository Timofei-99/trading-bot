import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { HourMinute, localWallTimeToUtcMs, minuteOfDay, parseHhMm } from '../domain/time/session';
import { ZoneOffsetTable } from '../domain/time/zone-offset-table';

const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60_000;

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
 * The window is resolved to an INSTANT per day — the session's opening wall
 * time converted to UTC, plus the duration — rather than by filtering bars on
 * their minute-of-day. The two agree on every ordinary day and differ on the
 * two that matter: on the fall-back day a minute-of-day filter would match
 * both passes of the repeated hour and quietly build a 60-minute balance out
 * of 120 minutes of bars, and on the spring-forward day a window inside the
 * gap would match nothing at all and emit no pattern without a word. Resolving
 * the instant instead gives a real 60 minutes in the first case and shifts to
 * the first valid instant in the second.
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

    // Every local calendar day the data touches. `YYYY-MM-DD` sorts
    // lexicographically in chronological order.
    const days = new Set<string>();
    for (let i = 0; i < candles.length; i++) {
      days.add(table.localDateKey(time[i]));
    }

    const patterns: Pattern[] = [];

    for (const day of [...days].sort()) {
      const openMs = localWallTimeToUtcMs(table, day, this.start, {
        onNonexistent: 'shiftForward',
        onAmbiguous: 'earlier',
      });
      const closeMs = openMs + this.durationMinutes * MINUTE_MS;

      const from = candles.searchSortedLeft(openMs);
      const to = candles.searchSortedLeft(closeMs);
      if (from >= to) {
        continue;
      }

      let sessionHigh = -Infinity;
      let sessionLow = Infinity;
      for (let i = from; i < to; i++) {
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
          startTime: time[from],
          endTime: time[to - 1],
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
