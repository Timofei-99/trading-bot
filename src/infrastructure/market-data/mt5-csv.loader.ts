import { readFileSync } from 'node:fs';

import { BarTuple, CandleSeries } from '../../domain/candle-series';
import { ZoneOffsetTable } from '../../domain/time/zone-offset-table';

export interface Mt5Row {
  /** Null when the wall-clock time was ambiguous — see the note below. */
  readonly timestamp: number | null;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface Mt5LoadResult {
  /** Every row the legacy loader would have produced, in its order. */
  readonly rows: Mt5Row[];
  /** The rows that carry a timestamp, as a series the engine can replay. */
  readonly series: CandleSeries;
  readonly ambiguousRows: number;
}

export interface Mt5LoadOptions {
  /** Broker server timezone. Eurex publishes FDAX in Europe/Berlin. */
  readonly sourceTz?: string;
  /** Field separator; auto-detected from the header when omitted. */
  readonly separator?: string;
}

const REQUIRED = ['open', 'high', 'low', 'close'] as const;

/**
 * Read an OHLCV export from MetaTrader 5.
 *
 * The export is tab- (sometimes comma-) separated with a bracketed header:
 *
 *     <DATE>	<TIME>	<OPEN>	<HIGH>	<LOW>	<CLOSE>	<TICKVOL>	<VOL>	<SPREAD>
 *     2024.01.02	08:00:00	16780.5	16785.0	16775.0	16783.0	1234	0	1
 *
 * Broker server time is usually NOT UTC, so timestamps are read as local wall
 * times in `sourceTz` and converted. That makes daylight saving the tricky
 * part, and the behaviour here is pinned by `mt5/fdax_dst_expected.json`
 * rather than by this description:
 *
 *  - A NONEXISTENT wall time (inside the spring-forward gap) shifts to the
 *    first valid instant, which is the transition itself. Both 02:00 and 02:30
 *    on 2024-03-31 therefore become 03:00 local, and collide with a real 03:00
 *    row; the last one in the file wins.
 *  - An AMBIGUOUS wall time (during the fall-back hour) yields no timestamp at
 *    all. The Python loader left such rows in the frame with a NaT index, and
 *    `rows` reproduces that faithfully.
 *
 * `series` is the one deliberate departure: a bar with no timestamp cannot
 * take part in a time-ordered replay, so it is excluded there. Callers that
 * need byte-level fidelity with the old loader read `rows`.
 */
export function parseMt5Csv(text: string, options: Mt5LoadOptions = {}): Mt5LoadResult {
  const sourceTz = options.sourceTz ?? 'Europe/Berlin';

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new Error('MT5 export is empty');
  }

  const separator = options.separator ?? (lines[0].includes('\t') ? '\t' : ',');
  const header = lines[0].split(separator).map((name) => name.trim().replace(/^<|>$/g, '').toLowerCase());

  const column = (name: string): number => header.indexOf(name);
  if (column('date') < 0 || column('time') < 0) {
    throw new Error(`Missing DATE/TIME columns; got ${JSON.stringify(header)}`);
  }
  for (const name of REQUIRED) {
    if (column(name) < 0) {
      throw new Error(`Missing ${name.toUpperCase()} column in MT5 export`);
    }
  }

  // tickvol wins over vol, matching the column precedence of the original.
  const volumeColumn =
    column('volume') >= 0 ? column('volume') : column('tickvol') >= 0 ? column('tickvol') : column('vol');

  const parsed: { timestamp: number | null; row: Mt5Row }[] = [];
  let ambiguousRows = 0;

  const bounds = wallTimeBounds(lines.slice(1), separator, column('date'));
  const table = ZoneOffsetTable.forZone(sourceTz, bounds.from, bounds.to);

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(separator);
    const localMs = parseWallTime(fields[column('date')], fields[column('time')]);
    const resolved = table.resolveLocal(localMs);

    let timestamp: number | null;
    if (resolved.kind === 'unique') {
      timestamp = resolved.utcMs;
    } else if (resolved.kind === 'nonexistent') {
      timestamp = resolved.shiftForwardUtcMs;
    } else {
      timestamp = null;
      ambiguousRows += 1;
    }

    parsed.push({
      timestamp,
      row: {
        timestamp,
        open: Number(fields[column('open')]),
        high: Number(fields[column('high')]),
        low: Number(fields[column('low')]),
        close: Number(fields[column('close')]),
        volume: volumeColumn >= 0 ? Number(fields[volumeColumn]) : 0,
      },
    });
  }

  // Deduplicate in FILE order keeping the last occurrence, then sort — the
  // order pandas applied, and the reason a shifted row can replace a real one.
  const lastIndexByKey = new Map<number | 'null', number>();
  parsed.forEach((entry, i) => {
    lastIndexByKey.set(entry.timestamp ?? 'null', i);
  });
  const deduped = parsed.filter((entry, i) => lastIndexByKey.get(entry.timestamp ?? 'null') === i);

  // Rows without a timestamp sort last, as NaT did.
  deduped.sort((a, b) => {
    if (a.timestamp === null) {
      return b.timestamp === null ? 0 : 1;
    }
    if (b.timestamp === null) {
      return -1;
    }
    return a.timestamp - b.timestamp;
  });

  const rows = deduped.map((entry) => entry.row);
  const bars: BarTuple[] = rows
    .filter((row) => row.timestamp !== null)
    .map((row) => [row.timestamp as number, row.open, row.high, row.low, row.close, row.volume]);

  return { rows, series: CandleSeries.fromBars(bars), ambiguousRows };
}

export function loadMt5Csv(path: string, options: Mt5LoadOptions = {}): Mt5LoadResult {
  return parseMt5Csv(readFileSync(path, 'utf8'), options);
}

/** `YYYY.MM.DD` + `HH:MM[:SS]` as a wall time, in pseudo-UTC milliseconds. */
function parseWallTime(date: string, time: string): number {
  const day = /^\s*(\d{4})\.(\d{2})\.(\d{2})\s*$/.exec(date);
  const clock = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(time);
  if (day === null || clock === null) {
    throw new Error(`Could not parse timestamp: ${JSON.stringify(`${date} ${time}`)}`);
  }
  return Date.UTC(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    Number(clock[1]),
    Number(clock[2]),
    clock[3] === undefined ? 0 : Number(clock[3]),
  );
}

/** Rough UTC span of the file, used to size the offset table. */
function wallTimeBounds(
  rows: string[],
  separator: string,
  dateColumn: number,
): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const line of rows) {
    const date = line.split(separator)[dateColumn];
    const day = /^\s*(\d{4})\.(\d{2})\.(\d{2})\s*$/.exec(date ?? '');
    if (day === null) {
      continue;
    }
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    from = Math.min(from, ms);
    to = Math.max(to, ms);
  }

  if (!Number.isFinite(from)) {
    const now = Date.UTC(2024, 0, 1);
    return { from: now, to: now };
  }
  return { from, to };
}
