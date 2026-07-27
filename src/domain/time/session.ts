import { ZoneOffsetTable } from './zone-offset-table';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

export interface HourMinute {
  readonly hour: number;
  readonly minute: number;
}

/** Parse an `HH:MM` session boundary, rejecting anything else. */
export function parseHhMm(value: string): HourMinute {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`session time must be HH:MM, got ${JSON.stringify(value)}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60) {
    throw new Error(`session time out of range: ${JSON.stringify(value)}`);
  }
  return { hour, minute };
}

export function minuteOfDay(time: HourMinute): number {
  return time.hour * 60 + time.minute;
}

/** Advance a wall-clock time; session windows are not allowed to cross midnight. */
export function addMinutes(time: HourMinute, minutes: number): HourMinute {
  const total = minuteOfDay(time) + minutes;
  if (total >= MINUTES_PER_DAY) {
    throw new Error('Session window must not cross midnight');
  }
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

export function compareHourMinute(a: HourMinute, b: HourMinute): number {
  return minuteOfDay(a) - minuteOfDay(b);
}

export interface WallTimePolicy {
  /** Wall time swallowed by a spring-forward gap. */
  readonly onNonexistent?: 'throw' | 'shiftForward';
  /** Wall time that occurs twice during a fall-back hour. */
  readonly onAmbiguous?: 'throw' | 'earlier' | 'later';
}

/**
 * Resolve `YYYY-MM-DD` + `HH:MM` in the table's zone to a UTC instant.
 *
 * The default policy mirrors `pd.Timestamp(f"{date} {time}", tz=zone)`: raise
 * rather than guess. That is right for parsing data, where a wall time that
 * cannot exist means the input is wrong.
 *
 * It is the wrong default for a *derived* time such as a session boundary. A
 * session that ends at 02:30 local is a perfectly sensible configuration; on
 * one day a year that instant does not exist, and throwing there would abort
 * an entire backtest over a calendar artefact. Those callers pass
 * `shiftForward` / `earlier` and get the nearest real instant instead.
 */
export function localWallTimeToUtcMs(
  table: ZoneOffsetTable,
  dateKey: string,
  time: HourMinute,
  policy: WallTimePolicy = {},
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    throw new Error(`session date must be YYYY-MM-DD, got ${JSON.stringify(dateKey)}`);
  }
  const localMs =
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) +
    minuteOfDay(time) * MINUTE_MS;

  const clock = `${dateKey} ${time.hour}:${time.minute}`;
  const resolved = table.resolveLocal(localMs);

  if (resolved.kind === 'nonexistent') {
    if ((policy.onNonexistent ?? 'throw') === 'throw' || resolved.shiftForwardUtcMs === null) {
      throw new Error(`${clock} does not exist in ${table.zone}`);
    }
    return resolved.shiftForwardUtcMs;
  }

  if (resolved.kind === 'ambiguous') {
    const choice = policy.onAmbiguous ?? 'throw';
    if (choice === 'throw') {
      throw new Error(`${clock} is ambiguous in ${table.zone}`);
    }
    return (choice === 'later' ? resolved.laterUtcMs : resolved.utcMs) as number;
  }

  return resolved.utcMs as number;
}
