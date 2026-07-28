#!/usr/bin/env ts-node
/**
 * Downloads DE30EUR 1m OHLCV data from Dukascopy's free public tick feed
 * and saves it as an MT5-compatible tab-separated CSV.
 *
 * Timestamps in the output file are UTC. Load with --tz UTC:
 *   npm run cli -- backtest:frankfurt --tz UTC
 *
 * Usage:
 *   npm run download-dax                        # last 2 years → today
 *   npm run download-dax -- 2023-01-01          # from date → today
 *   npm run download-dax -- 2023-01-01 2024-12-31
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as lzma from 'lzma-native';

// DAX CFD on Dukascopy (EUR denominated, ~18 000–20 000 pts)
const INSTRUMENT = 'DE30EUR';
// Prices are stored as integer = actual_price * POINT_FACTOR (1 decimal place for DE30)
const POINT_FACTOR = 10;
const BYTES_PER_TICK = 20;
const OUTPUT_PATH = join('data', 'dax_1m.csv');

export interface Bar {
  ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  ms: number;
  mid: number;
  vol: number;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function fetchHour(
  year: number,
  month0: number,
  day: number,
  hour: number,
): Promise<Buffer | null> {
  const url = [
    'https://datafeed.dukascopy.com/datafeed',
    INSTRUMENT,
    String(year),
    pad(month0), // Dukascopy uses 0-indexed months in the URL
    pad(day),
    `${pad(hour)}h_ticks.bi5`,
  ].join('/');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html') || ct.includes('application/xml')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length === 0 ? null : buf;
  } catch {
    return null;
  }
}

// ─── LZMA ────────────────────────────────────────────────────────────────────

function decompress(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      lzma.decompress(data, undefined, (result: Buffer) => resolve(result));
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Binary parsing ───────────────────────────────────────────────────────────

/**
 * Dukascopy's `.bi5` payload: fixed 20-byte records, big-endian, prices as
 * integers scaled by `POINT_FACTOR` and the timestamp as a millisecond offset
 * from the start of the hour the file covers.
 *
 * A trailing partial record is ignored rather than treated as an error — the
 * feed occasionally serves a truncated hour, and losing its last tick is
 * cheaper than losing the day.
 */
export function parseTicks(raw: Buffer, hourStartMs: number): Tick[] {
  const ticks: Tick[] = [];
  for (let i = 0; i + BYTES_PER_TICK <= raw.length; i += BYTES_PER_TICK) {
    const msOffset = raw.readUInt32BE(i);
    const ask = raw.readUInt32BE(i + 4) / POINT_FACTOR;
    const bid = raw.readUInt32BE(i + 8) / POINT_FACTOR;
    const askVol = raw.readFloatBE(i + 12);
    const bidVol = raw.readFloatBE(i + 16);
    ticks.push({ ms: hourStartMs + msOffset, mid: (ask + bid) / 2, vol: askVol + bidVol });
  }
  return ticks;
}

// ─── OHLCV aggregation ────────────────────────────────────────────────────────

/**
 * Fold ticks into 1m OHLCV.
 *
 * Open and close are taken from the first and last tick **in input order**,
 * so the caller must feed ticks chronologically — `main` does, hour by hour.
 * Only the returned bars are sorted; sorting here would not repair open/close
 * of an out-of-order input, so it would just hide the requirement.
 */
export function toMinuteBars(ticks: Tick[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const { ms, mid, vol } of ticks) {
    const barMs = Math.floor(ms / 60_000) * 60_000;
    const bar = map.get(barMs);
    if (bar === undefined) {
      map.set(barMs, { ms: barMs, open: mid, high: mid, low: mid, close: mid, volume: vol });
    } else {
      if (mid > bar.high) bar.high = mid;
      if (mid < bar.low) bar.low = mid;
      bar.close = mid;
      bar.volume += vol;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.ms - b.ms);
}

// ─── CSV formatting (MT5 tab-separated, UTC) ──────────────────────────────────

export function toMt5Row(bar: Bar): string {
  const d = new Date(bar.ms);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  return `${date}\t${time}\t${bar.open.toFixed(1)}\t${bar.high.toFixed(1)}\t${bar.low.toFixed(1)}\t${bar.close.toFixed(1)}\t${Math.round(bar.volume)}\t0\t0`;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function utcMidnight(iso: string): Date {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d;
}

export function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(from);
  while (cur <= to) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const toDate = new Date();
  toDate.setUTCHours(0, 0, 0, 0);

  const fromDate = new Date(toDate);
  fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 2);

  if (args[0]) fromDate.setTime(utcMidnight(args[0]).getTime());
  if (args[1]) toDate.setTime(utcMidnight(args[1]).getTime());

  console.log(`Downloading ${INSTRUMENT} M1 from Dukascopy`);
  console.log(
    `Period: ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`,
  );
  console.log(`Output: ${OUTPUT_PATH}\n`);

  mkdirSync('data', { recursive: true });
  const stream = createWriteStream(OUTPUT_PATH, 'utf8');
  stream.write('<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n');

  let totalBars = 0;

  for (const day of eachDay(fromDate, toDate)) {
    const year = day.getUTCFullYear();
    const month0 = day.getUTCMonth(); // 0-indexed — used as-is in the Dukascopy URL
    const dayNum = day.getUTCDate();
    const label = `${year}-${pad(month0 + 1)}-${pad(dayNum)}`;

    const ticks: { ms: number; mid: number; vol: number }[] = [];

    for (let hour = 0; hour < 24; hour++) {
      const compressed = await fetchHour(year, month0, dayNum, hour);
      if (compressed === null) continue;

      try {
        const raw = await decompress(compressed);
        const hourStartMs = day.getTime() + hour * 3_600_000;
        ticks.push(...parseTicks(raw, hourStartMs));
      } catch {
        // corrupted hour — skip silently
      }
    }

    const bars = toMinuteBars(ticks);
    for (const bar of bars) {
      stream.write(toMt5Row(bar) + '\n');
    }
    totalBars += bars.length;

    if (bars.length > 0) {
      process.stdout.write(`  ${label}  ${bars.length} bars  (total ${totalBars})\r`);
    }
  }

  await new Promise<void>((resolve) => stream.end(resolve));
  process.stdout.write('\n');
  console.log(`\nDone — ${totalBars} bars saved to ${OUTPUT_PATH}`);
  console.log('\nRun backtest:');
  console.log('  npm run cli -- backtest:frankfurt --tz UTC');
}

// Only run when invoked as a script. Without this an `import` from a test
// would start a two-year download as a side effect of loading the module.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
