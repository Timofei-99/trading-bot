import { IANAZone } from 'luxon';

/**
 * Precomputed UTC-offset transitions for one IANA zone.
 *
 * Why not call a datetime library per bar: `InitialBalanceDetector` and the
 * Frankfurt session logic ask "what is the local wall-clock time of this bar"
 * for every bar of a 1-minute series. Doing that through Luxon would put an
 * object allocation and a zone lookup in the hottest loop we have. Instead the
 * transitions are resolved once (Luxon is used only here, at build time) and
 * every later query is a binary search plus an addition.
 *
 * The table also answers the question pandas answered with
 * `ambiguous=` / `nonexistent=`: whether a *local* wall time exists once,
 * twice, or not at all. `data/mt5_loader.py` depends on that distinction, and
 * a library that silently picks one offset (as most do) cannot reproduce it.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Wider than any real offset change, so it always brackets a transition. */
const BRACKET_MS = 26 * 3_600_000;

export type LocalResolutionKind = 'unique' | 'ambiguous' | 'nonexistent';

export interface LocalResolution {
  readonly kind: LocalResolutionKind;
  /** `unique`: the instant. `ambiguous`: the earlier (pre-transition) instant. */
  readonly utcMs: number | null;
  /** `ambiguous`: the later (post-transition) instant. */
  readonly laterUtcMs: number | null;
  /** `nonexistent`: the first valid instant after the gap (pandas "shift_forward"). */
  readonly shiftForwardUtcMs: number | null;
}

const cache = new Map<string, ZoneOffsetTable>();

export class ZoneOffsetTable {
  private constructor(
    readonly zone: string,
    readonly fromUtcMs: number,
    readonly toUtcMs: number,
    /** Sorted instants at which the offset changes. */
    private readonly transitions: Float64Array,
    /** Offset in minutes that becomes effective at `transitions[i]`. */
    private readonly offsetsAfter: Float64Array,
    /** Offset in minutes before the first transition. */
    private readonly baseOffsetMinutes: number,
  ) {}

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Build (and memoize) a table covering the calendar years around the range. */
  static forZone(zone: string, fromUtcMs: number, toUtcMs: number): ZoneOffsetTable {
    if (!IANAZone.isValidZone(zone)) {
      throw new Error(`Unknown time zone: ${zone}`);
    }
    const fromYear = new Date(fromUtcMs).getUTCFullYear() - 1;
    const toYear = new Date(toUtcMs).getUTCFullYear() + 1;
    const key = `${zone}|${fromYear}|${toYear}`;

    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const table = ZoneOffsetTable.build(zone, fromYear, toYear);
    cache.set(key, table);
    return table;
  }

  /** Table covering `[fromYear, toYear]` inclusive, in UTC calendar years. */
  static forYears(zone: string, fromYear: number, toYear: number): ZoneOffsetTable {
    return ZoneOffsetTable.forZone(
      zone,
      Date.UTC(fromYear + 1, 0, 1),
      Date.UTC(toYear - 1, 11, 31),
    );
  }

  private static build(zone: string, fromYear: number, toYear: number): ZoneOffsetTable {
    const ianaZone = IANAZone.create(zone);
    const offsetAt = (ms: number): number => ianaZone.offset(ms);

    const start = Date.UTC(fromYear, 0, 1);
    const end = Date.UTC(toYear + 1, 0, 1);

    const baseOffsetMinutes = offsetAt(start);
    const transitions: number[] = [];
    const offsetsAfter: number[] = [];

    let previous = baseOffsetMinutes;
    for (let probe = start + DAY_MS; probe <= end; probe += DAY_MS) {
      const current = offsetAt(probe);
      if (current === previous) {
        continue;
      }
      // Narrow to the exact minute. Modern zones only ever switch on a whole
      // minute boundary; the padded range never reaches LMT-era offsets.
      let lo = probe - DAY_MS;
      let hi = probe;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
        if (mid <= lo) {
          break;
        }
        if (offsetAt(mid) === previous) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      transitions.push(hi);
      offsetsAfter.push(current);
      previous = current;
    }

    return new ZoneOffsetTable(
      zone,
      start,
      end,
      Float64Array.from(transitions),
      Float64Array.from(offsetsAfter),
      baseOffsetMinutes,
    );
  }

  // -------------------------------------------------------------------------
  // UTC -> local
  // -------------------------------------------------------------------------

  /** Index of the last transition at or before `utcMs`, or -1. */
  private transitionIndexAt(utcMs: number): number {
    let lo = 0;
    let hi = this.transitions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.transitions[mid] <= utcMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo - 1;
  }

  offsetMinutesAt(utcMs: number): number {
    const index = this.transitionIndexAt(utcMs);
    return index < 0 ? this.baseOffsetMinutes : this.offsetsAfter[index];
  }

  /** Wall-clock time as "pseudo-UTC" milliseconds: usable with plain arithmetic. */
  toLocalMs(utcMs: number): number {
    return utcMs + this.offsetMinutesAt(utcMs) * MINUTE_MS;
  }

  /** Minutes since local midnight — the shape session windows are defined in. */
  localMinuteOfDay(utcMs: number): number {
    const local = this.toLocalMs(utcMs);
    return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS);
  }

  /** Local midnight of the bar's calendar day, as pseudo-UTC ms. */
  localDayStartMs(utcMs: number): number {
    return Math.floor(this.toLocalMs(utcMs) / DAY_MS) * DAY_MS;
  }

  /** Local calendar day as `YYYY-MM-DD` — the session grouping key. */
  localDateKey(utcMs: number): string {
    return new Date(this.localDayStartMs(utcMs)).toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // local -> UTC
  // -------------------------------------------------------------------------

  /**
   * Classify a local wall time and map it back to UTC.
   *
   * A wall time is ambiguous when the clock is turned back over it (it happens
   * twice) and nonexistent when the clock is turned forward over it. pandas
   * signalled these with `ambiguous="NaT"` and `nonexistent="shift_forward"`;
   * this returns enough information for a caller to reproduce either.
   */
  resolveLocal(localMs: number): LocalResolution {
    const before = this.offsetMinutesAt(localMs - BRACKET_MS);
    const after = this.offsetMinutesAt(localMs + BRACKET_MS);

    const valid: number[] = [];
    for (const offset of before === after ? [before] : [before, after]) {
      const candidate = localMs - offset * MINUTE_MS;
      if (this.offsetMinutesAt(candidate) === offset) {
        valid.push(candidate);
      }
    }
    valid.sort((a, b) => a - b);

    if (valid.length === 1) {
      return { kind: 'unique', utcMs: valid[0], laterUtcMs: null, shiftForwardUtcMs: null };
    }
    if (valid.length >= 2) {
      return {
        kind: 'ambiguous',
        utcMs: valid[0],
        laterUtcMs: valid[valid.length - 1],
        shiftForwardUtcMs: null,
      };
    }
    return {
      kind: 'nonexistent',
      utcMs: null,
      laterUtcMs: null,
      shiftForwardUtcMs: this.gapEndFor(localMs, before),
    };
  }

  /** First valid instant after the forward jump that swallowed `localMs`. */
  private gapEndFor(localMs: number, offsetBeforeGuess: number): number | null {
    const approximateUtc = localMs - offsetBeforeGuess * MINUTE_MS;
    const start = this.transitionIndexAt(approximateUtc);

    for (const index of [start, start + 1]) {
      if (index < 0 || index >= this.transitions.length) {
        continue;
      }
      const at = this.transitions[index];
      const offsetBefore = index === 0 ? this.baseOffsetMinutes : this.offsetsAfter[index - 1];
      const offsetAfter = this.offsetsAfter[index];
      if (offsetAfter <= offsetBefore) {
        continue;
      }
      const gapStartLocal = at + offsetBefore * MINUTE_MS;
      const gapEndLocal = at + offsetAfter * MINUTE_MS;
      if (localMs >= gapStartLocal && localMs < gapEndLocal) {
        return at;
      }
    }
    return null;
  }
}
