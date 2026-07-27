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

/**
 * Resolve `YYYY-MM-DD` + `HH:MM` in the table's zone to a UTC instant.
 *
 * Mirrors `pd.Timestamp(f"{date} {time}", tz=zone)`, which raises rather than
 * guessing when the wall time is ambiguous or does not exist.
 */
export function localWallTimeToUtcMs(
  table: ZoneOffsetTable,
  dateKey: string,
  time: HourMinute,
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    throw new Error(`session date must be YYYY-MM-DD, got ${JSON.stringify(dateKey)}`);
  }
  const localMs =
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) +
    minuteOfDay(time) * MINUTE_MS;

  const resolved = table.resolveLocal(localMs);
  if (resolved.kind === 'nonexistent') {
    throw new Error(`${dateKey} ${time.hour}:${time.minute} does not exist in ${table.zone}`);
  }
  if (resolved.kind === 'ambiguous') {
    throw new Error(`${dateKey} ${time.hour}:${time.minute} is ambiguous in ${table.zone}`);
  }
  return resolved.utcMs as number;
}
