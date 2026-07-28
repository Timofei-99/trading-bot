import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { Trade } from '@bot/core/domain/trade';

export interface ReportFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly modifiedMs: number;
}

/**
 * Reads and writes the generated report directory.
 *
 * Filenames carry the trade's PnL, encoded the way the Python runners did it:
 * `+2.5%` becomes `p2_5pct`, `-1.75%` becomes `m1_75pct`. It is not pretty,
 * but the reports directory is sorted and skimmed by humans and the old naming
 * is what they are used to.
 */
@Injectable()
export class ReportService {
  constructor(readonly reportsDir = 'reports') {}

  /** `+2.50%` -> `p2_50pct`; `-1.75%` -> `m1_75pct`. */
  static pnlTag(pnlPct: number | null, digits = 2): string {
    const value = (pnlPct ?? 0) * 100;
    const signed = `${value >= 0 ? '+' : ''}${value.toFixed(digits)}pct`;
    return signed.replace('+', 'p').replace('-', 'm').replace('.', '_');
  }

  static tradeFilename(prefix: string, index: number, trade: Trade, digits = 2): string {
    const number = String(index).padStart(2, '0');
    return `${prefix}_trade_${number}_${ReportService.pnlTag(trade.pnlPct, digits)}.html`;
  }

  ensureDir(): string {
    mkdirSync(this.reportsDir, { recursive: true });
    return this.reportsDir;
  }

  pathFor(filename: string): string {
    // Reject anything that would escape the reports directory: the HTTP layer
    // passes user input straight through to this.
    const safe = basename(filename);
    if (safe !== filename || safe === '' || safe === '.' || safe === '..') {
      throw new Error(`Invalid report filename: ${filename}`);
    }
    const path = resolve(join(this.reportsDir, safe));
    if (!path.startsWith(resolve(this.reportsDir))) {
      throw new Error(`Invalid report filename: ${filename}`);
    }
    return path;
  }

  list(): ReportFile[] {
    if (!existsSync(this.reportsDir)) {
      return [];
    }
    return readdirSync(this.reportsDir)
      .filter((name) => name.endsWith('.html') || name.endsWith('.txt'))
      .map((filename) => {
        const stats = statSync(join(this.reportsDir, filename));
        return { filename, sizeBytes: stats.size, modifiedMs: stats.mtimeMs };
      })
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  read(filename: string): string {
    return readFileSync(this.pathFor(filename), 'utf8');
  }

  writeText(filename: string, contents: string): string {
    this.ensureDir();
    const path = this.pathFor(filename);
    writeFileSync(path, contents, 'utf8');
    return path;
  }
}
