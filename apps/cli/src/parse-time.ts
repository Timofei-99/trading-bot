const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Parse a command-line instant, strictly.
 *
 * `Date.parse` is a trap on this input. A date-only string is read as UTC, but
 * the same string with a time and no zone is read in the machine's LOCAL zone
 * — so `--start 2023-06-01` and `--start 2023-06-01T00:00:00` silently select
 * different ranges, by however many hours the operator happens to be from UTC.
 * And an unparseable value yields `NaN`, which flows all the way into a range
 * query and comes back as an empty result with no error anywhere.
 *
 * So: accept a bare date as UTC midnight, accept an explicit offset, and
 * reject everything else by name.
 */
export function parseInstant(value: string, flag: string): number {
  const trimmed = value.trim();

  if (DATE_ONLY.test(trimmed)) {
    assertRealCalendarDate(trimmed, value, flag);
    return Date.parse(`${trimmed}T00:00:00Z`);
  }

  if (WITH_OFFSET.test(trimmed)) {
    assertRealCalendarDate(trimmed.slice(0, 10), value, flag);
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new Error(`${flag}: ${JSON.stringify(value)} is not a real date`);
    }
    return parsed;
  }

  if (WITHOUT_OFFSET.test(trimmed)) {
    throw new Error(
      `${flag}: ${JSON.stringify(value)} has no timezone, so it would be read in this machine's ` +
        `local zone and shift the range. Append "Z" for UTC, e.g. ${trimmed}Z`,
    );
  }

  throw new Error(
    `${flag}: cannot read ${JSON.stringify(value)} as a date. ` +
      'Use YYYY-MM-DD or a full ISO-8601 instant such as 2023-06-01T00:00:00Z',
  );
}

/**
 * Reject a calendar date that does not exist.
 *
 * `Date.parse` rolls impossible dates over instead of failing:
 * `2023-02-30T00:00:00Z` comes back as 2023-03-02, which would quietly move a
 * backtest window by two days.
 */
function assertRealCalendarDate(datePart: string, original: string, flag: string): void {
  const [year, month, day] = datePart.split('-').map(Number);
  const rolled = new Date(Date.UTC(year, month - 1, day));

  if (
    month < 1 ||
    month > 12 ||
    rolled.getUTCFullYear() !== year ||
    rolled.getUTCMonth() !== month - 1 ||
    rolled.getUTCDate() !== day
  ) {
    throw new Error(`${flag}: ${JSON.stringify(original)} is not a real date`);
  }
}

/** Parse a `YYYY-MM` chart month into its UTC half-open range. */
export function parseMonth(value: string, flag: string): { startMs: number; endMs: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (match === null) {
    throw new Error(`${flag}: expected YYYY-MM, got ${JSON.stringify(value)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`${flag}: month out of range in ${JSON.stringify(value)}`);
  }
  return { startMs: Date.UTC(year, month - 1, 1), endMs: Date.UTC(year, month, 1) };
}

/** Reject a range that a data source could never satisfy. */
export function assertRange(startMs: number, endMs: number): void {
  if (startMs >= endMs) {
    throw new Error(
      `--start (${new Date(startMs).toISOString()}) must be before --end (${new Date(endMs).toISOString()})`,
    );
  }
}
