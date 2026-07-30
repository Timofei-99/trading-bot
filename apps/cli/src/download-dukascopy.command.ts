import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getHistoricalRates } from 'dukascopy-node';
import { Command, CommandRunner, Option } from 'nest-commander';

interface DownloadOptions {
  instrument?: string;
  label?: string;
  from: string;
  to: string;
  out?: string;
  price?: 'ask' | 'bid';
  overwrite?: boolean;
}

@Command({
  name: 'download:dukascopy',
  description: 'Download 1m OHLCV data from Dukascopy and save as per-day CSV files',
})
export class DownloadDukascopyCommand extends CommandRunner {
  async run(_args: string[], options: DownloadOptions): Promise<void> {
    const instrument = options.instrument ?? 'deuidxeur';
    const label = options.label ?? instrumentLabel(instrument);
    const price = options.price ?? 'ask';
    const outDir = options.out ?? 'data';
    const overwrite = options.overwrite ?? false;

    mkdirSync(outDir, { recursive: true });

    // Fetch the whole range at once — dukascopy-node batches internally.
    console.log(`Downloading ${instrument} 1m ${price.toUpperCase()} from ${options.from} to ${options.to} …`);
    const rows: [number, number, number, number, number, number][] = await getHistoricalRates({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instrument: instrument as any,
      dates: { from: options.from, to: options.to },
      timeframe: 'm1',
      priceType: price,
      format: 'array',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    if (rows.length === 0) {
      console.log('No data returned.');
      return;
    }

    // Group by UTC calendar day.
    const byDay = new Map<string, typeof rows>();
    for (const row of rows) {
      const date = new Date(row[0]).toISOString().slice(0, 10);
      let bucket = byDay.get(date);
      if (bucket === undefined) {
        bucket = [];
        byDay.set(date, bucket);
      }
      bucket.push(row);
    }

    const priceTag = price.toUpperCase();
    let written = 0;
    let skipped = 0;

    for (const [date, candles] of [...byDay.entries()].sort()) {
      const filename = `${label}_1Minute_${priceTag}_${date}_00_00-23_59_Etc_UTC.csv`;
      const path = join(outDir, filename);

      if (existsSync(path) && !overwrite) {
        skipped += 1;
        continue;
      }

      const lines = ['Etc/UTC,Open,High,Low,Close,Volume'];
      for (const [ts, open, high, low, close, volume] of candles) {
        const iso = new Date(ts).toISOString().replace(/\.000Z$/, '+00:00');
        lines.push(`${iso},${open},${high},${low},${close},${volume}`);
      }

      writeFileSync(path, lines.join('\n') + '\n', 'utf8');
      console.log(`  → ${filename}  (${candles.length} bars)`);
      written += 1;
    }

    console.log(`\nDone. ${written} file(s) written, ${skipped} skipped (already exist).`);
  }

  @Option({ flags: '--instrument <code>', description: 'Dukascopy instrument code (default: deuidxeur = DAX)' })
  parseInstrument(v: string): string { return v; }

  @Option({ flags: '--label <name>', description: 'File prefix, e.g. DEU.IDX-EUR (derived from instrument if omitted)' })
  parseLabel(v: string): string { return v; }

  @Option({ flags: '--from <date>', description: 'Start date YYYY-MM-DD (inclusive)', required: true })
  parseFrom(v: string): string { return v; }

  @Option({ flags: '--to <date>', description: 'End date YYYY-MM-DD (inclusive)', required: true })
  parseTo(v: string): string { return v; }

  @Option({ flags: '--out <dir>', description: 'Output directory (default: data/)' })
  parseOut(v: string): string { return v; }

  @Option({ flags: '--price <type>', description: 'ask or bid (default: ask)' })
  parsePrice(v: string): 'ask' | 'bid' {
    if (v !== 'ask' && v !== 'bid') throw new Error('--price must be ask or bid');
    return v;
  }

  @Option({ flags: '--overwrite', description: 'Re-download files that already exist' })
  parseOverwrite(): boolean { return true; }
}

function instrumentLabel(instrument: string): string {
  // Known mappings; fall back to uppercased code.
  const known: Record<string, string> = {
    deuidxeur: 'DEU.IDX-EUR',
    fraidxeur: 'FRA.IDX-EUR',
    gbridxgbp: 'GBR.IDX-GBP',
    jpnidxjpy: 'JPN.IDX-JPY',
    usaidxusd: 'USA.IDX-USD',
    spxidxusd: 'SPX.IDX-USD',
    chiidxusd: 'CHI.IDX-USD',
  };
  return known[instrument] ?? instrument.toUpperCase();
}
