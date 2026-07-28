#!/usr/bin/env ts-node
/**
 * Downloads DE30_EUR (GER40 / DAX) 1m OHLCV data from OANDA's free REST API
 * and saves it as an MT5-compatible tab-separated CSV.
 *
 * Requirements:
 *   1. Sign up for a free practice account at https://www.oanda.com/register/#/sign-up/demo
 *   2. Log in → My Account → Manage API Access → Generate personal access token
 *
 * Usage:
 *   npm run download-ger40 -- --token YOUR_API_TOKEN
 *   npm run download-ger40 -- --token TOKEN --from 2023-01-01 --to 2024-12-31
 *   npm run download-ger40 -- --token TOKEN --instrument DE40_EUR   # if OANDA uses the new name
 *   npm run download-ger40 -- --token TOKEN --live                  # live account instead of practice
 *
 * Output is UTC-timestamped. Run the backtest with:
 *   npm run cli -- backtest:frankfurt --tz UTC
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INSTRUMENT = 'DE30_EUR'; // OANDA's name for GER40/DAX — try DE40_EUR if this 404s
const GRANULARITY = 'M1';
const MAX_CANDLES_PER_REQUEST = 5000; // OANDA hard limit
const REQUEST_DELAY_MS = 250;
const OUTPUT_PATH = join('data', 'dax_1m.csv');

interface CliArgs {
  token: string;
  instrument: string;
  from: Date;
  to: Date;
  baseUrl: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let token = '';
  let instrument = DEFAULT_INSTRUMENT;
  let fromStr = '';
  let toStr = '';
  let live = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag === '--token' || flag === '-t') && argv[i + 1]) token = argv[++i];
    else if (flag === '--instrument' && argv[i + 1]) instrument = argv[++i];
    else if (flag === '--from' && argv[i + 1]) fromStr = argv[++i];
    else if (flag === '--to' && argv[i + 1]) toStr = argv[++i];
    else if (flag === '--live') live = true;
  }

  if (!token) {
    console.error('Error: --token is required.');
    console.error('');
    console.error('Steps:');
    console.error('  1. Sign up for free at https://www.oanda.com/register/#/sign-up/demo');
    console.error('  2. Log in → My Account → Manage API Access → Generate token');
    console.error('  3. Re-run: npm run download-ger40 -- --token YOUR_TOKEN');
    process.exit(1);
  }

  const to = toStr
    ? new Date(toStr + 'T00:00:00Z')
    : (() => {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
      })();

  const from = fromStr
    ? new Date(fromStr + 'T00:00:00Z')
    : (() => {
        const d = new Date(to);
        d.setUTCFullYear(d.getUTCFullYear() - 2);
        return d;
      })();

  const baseUrl = live ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';

  return { token, instrument, from, to, baseUrl };
}

interface OandaCandle {
  time: string;
  mid: { o: string; h: string; l: string; c: string };
  volume: number;
  complete: boolean;
}

async function fetchWindow(
  token: string,
  baseUrl: string,
  instrument: string,
  from: Date,
  to: Date,
): Promise<OandaCandle[]> {
  const url = new URL(`${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles`);
  url.searchParams.set('granularity', GRANULARITY);
  url.searchParams.set('price', 'M');
  url.searchParams.set('from', from.toISOString());
  url.searchParams.set('to', to.toISOString());
  url.searchParams.set('count', String(MAX_CANDLES_PER_REQUEST));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OANDA ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { candles?: OandaCandle[] };
  return data.candles ?? [];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toMt5Row(c: OandaCandle): string {
  const d = new Date(c.time);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  const o = parseFloat(c.mid.o).toFixed(1);
  const h = parseFloat(c.mid.h).toFixed(1);
  const l = parseFloat(c.mid.l).toFixed(1);
  const cl = parseFloat(c.mid.c).toFixed(1);
  return `${date}\t${time}\t${o}\t${h}\t${l}\t${cl}\t${c.volume}\t0\t0`;
}

async function main(): Promise<void> {
  const { token, instrument, from, to, baseUrl } = parseArgs();
  const env = baseUrl.includes('practice') ? 'practice' : 'live';

  console.log(`Downloading ${instrument} M1 from OANDA (${env})`);
  console.log(`Period : ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  console.log(`Output : ${OUTPUT_PATH}\n`);

  // Probe instrument before starting full download
  const probe = await fetchWindow(
    token,
    baseUrl,
    instrument,
    from,
    new Date(from.getTime() + 3 * 3_600_000),
  );
  if (probe.length === 0) {
    console.error(`No data returned for instrument "${instrument}".`);
    console.error(`Check the name — it might be DE40_EUR or GER40_EUR in your OANDA account.`);
    console.error(`Run: npm run download-ger40 -- --token TOKEN --instrument DE40_EUR`);
    process.exit(1);
  }
  console.log(`Instrument "${instrument}" confirmed — ${probe.length} bars in probe window.\n`);

  mkdirSync('data', { recursive: true });
  const stream = createWriteStream(OUTPUT_PATH, 'utf8');
  stream.write('<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n');

  let cursor = new Date(from);
  let totalBars = 0;

  while (cursor < to) {
    const windowEnd = new Date(
      Math.min(cursor.getTime() + MAX_CANDLES_PER_REQUEST * 60_000, to.getTime()),
    );

    const candles = await fetchWindow(token, baseUrl, instrument, cursor, windowEnd);

    for (const c of candles) {
      if (!c.complete) continue;
      stream.write(toMt5Row(c) + '\n');
      totalBars++;
    }

    if (candles.length === 0) {
      cursor = windowEnd;
    } else {
      const lastMs = new Date(candles[candles.length - 1].time).getTime();
      cursor = new Date(lastMs + 60_000);
    }

    process.stdout.write(`  ${cursor.toISOString().slice(0, 10)}  total ${totalBars} bars\r`);
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  await new Promise<void>((r) => stream.end(r));
  process.stdout.write('\n');
  console.log(`\nDone — ${totalBars} bars saved to ${OUTPUT_PATH}`);
  console.log('\nRun backtest:');
  console.log('  npm run cli -- backtest:frankfurt --tz UTC');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
