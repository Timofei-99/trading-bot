import { CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { Detector } from '../domain/ports';
import { sortByStartTime } from './swings';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** `[name, startHourUtcInclusive, endHourUtcExclusive]`. */
export type KillzoneWindow = readonly [string, number, number];

export const DEFAULT_KILLZONES: readonly KillzoneWindow[] = [
  ['asian', 1, 5],
  ['london_open', 7, 10],
  ['ny_open', 12, 15],
  ['london_close', 15, 17],
];

export interface KillzoneOptions {
  readonly timeframe?: string;
  readonly killzones?: readonly KillzoneWindow[];
}

/**
 * ICT killzones — fixed UTC hour bands of institutional activity.
 *
 * Defaults, half-open `[start, end)` in UTC hours:
 *   asian        01:00-05:00
 *   london_open  07:00-10:00
 *   ny_open      12:00-15:00
 *   london_close 15:00-17:00
 *
 * One pattern per (killzone, UTC calendar day) that contains at least one
 * candle. `startTime` / `endTime` are the first and last candle inside the
 * window; `high` / `low` span all of them.
 *
 * Unlike `InitialBalanceDetector` these bands are defined in UTC, so they do
 * not shift with daylight saving.
 *
 * meta: `name`, `candle_count`.
 */
export class KillzoneDetector implements Detector {
  readonly timeframe: string;
  readonly killzones: readonly KillzoneWindow[];

  constructor(options: KillzoneOptions = {}) {
    this.timeframe = options.timeframe ?? '';
    this.killzones = options.killzones ?? DEFAULT_KILLZONES;
  }

  detect(candles: CandleSeries): Pattern[] {
    if (candles.isEmpty) {
      return [];
    }

    const { time, high, low } = candles;
    const patterns: Pattern[] = [];

    for (const [name, startHour, endHour] of this.killzones) {
      // Group the in-window bars by UTC day, keeping bar order within a day.
      const byDay = new Map<number, number[]>();

      for (let i = 0; i < candles.length; i++) {
        const t = time[i];
        const hour = Math.floor((((t % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
        const inWindow =
          startHour < endHour
            ? hour >= startHour && hour < endHour
            : // window crossing midnight, e.g. 22:00-02:00
              hour >= startHour || hour < endHour;
        if (!inWindow) {
          continue;
        }
        const day = Math.floor(t / DAY_MS) * DAY_MS;
        const bucket = byDay.get(day);
        if (bucket === undefined) {
          byDay.set(day, [i]);
        } else {
          bucket.push(i);
        }
      }

      for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
        const indices = byDay.get(day) as number[];

        let zoneHigh = -Infinity;
        let zoneLow = Infinity;
        for (const i of indices) {
          if (high[i] > zoneHigh) {
            zoneHigh = high[i];
          }
          if (low[i] < zoneLow) {
            zoneLow = low[i];
          }
        }

        patterns.push(
          new Pattern({
            type: PatternType.Killzone,
            timeframe: this.timeframe,
            startTime: time[indices[0]],
            endTime: time[indices[indices.length - 1]],
            high: zoneHigh,
            low: zoneLow,
            meta: { name, candle_count: indices.length },
          }),
        );
      }
    }

    return sortByStartTime(patterns);
  }
}
