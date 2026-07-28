import { loadGolden } from '../../../../../test/fixtures/helpers';
import { ZoneOffsetTable } from './zone-offset-table';

interface LocalTimeFixture {
  dataset: string;
  zone: string;
  timestamps: number[];
  offsetMinutes: number[];
  minuteOfDay: number[];
  dateKey: string[];
}

interface ResolutionFixture {
  zone: string;
  wallTime: string;
  kind: 'unique' | 'ambiguous' | 'nonexistent';
  utc?: number;
  laterUtc?: number;
  shiftForwardUtc?: number;
}

function wallTimeToLocalMs(wallTime: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(wallTime);
  if (match === null) {
    throw new Error(`bad wall time in fixture: ${wallTime}`);
  }
  const [, y, m, d, hh, mm] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
}

describe('ZoneOffsetTable', () => {
  const berlin = ZoneOffsetTable.forZone(
    'Europe/Berlin',
    Date.UTC(2024, 0, 1),
    Date.UTC(2024, 11, 31),
  );

  it('rejects an unknown zone', () => {
    expect(() => ZoneOffsetTable.forZone('Mars/Olympus', 0, 0)).toThrow(/Unknown time zone/);
  });

  it('memoizes tables per zone and year range', () => {
    const again = ZoneOffsetTable.forZone(
      'Europe/Berlin',
      Date.UTC(2024, 5, 1),
      Date.UTC(2024, 6, 1),
    );
    expect(again).toBe(berlin);
  });

  describe('offsets around the 2024 Berlin transitions', () => {
    it('switches to summer time at the spring-forward instant', () => {
      const transition = Date.UTC(2024, 2, 31, 1, 0); // 01:00 UTC = 02:00 -> 03:00 local
      expect(berlin.offsetMinutesAt(transition - 1)).toBe(60);
      expect(berlin.offsetMinutesAt(transition)).toBe(120);
    });

    it('switches back to winter time at the fall-back instant', () => {
      const transition = Date.UTC(2024, 9, 27, 1, 0); // 01:00 UTC = 03:00 -> 02:00 local
      expect(berlin.offsetMinutesAt(transition - 1)).toBe(120);
      expect(berlin.offsetMinutesAt(transition)).toBe(60);
    });
  });

  describe.each(['frankfurt_1m_dst_mar', 'frankfurt_1m_dst_oct'])(
    'local wall clock parity on %s',
    (dataset) => {
      it('matches pandas tz_convert for every bar', () => {
        const fixture = loadGolden<LocalTimeFixture>('domain', `localtime.${dataset}.json`);
        const table = ZoneOffsetTable.forZone(
          fixture.zone,
          fixture.timestamps[0],
          fixture.timestamps[fixture.timestamps.length - 1],
        );

        expect(fixture.timestamps.length).toBeGreaterThan(1000);

        const offsets: number[] = [];
        const minutes: number[] = [];
        const dateKeys: string[] = [];
        for (const timestamp of fixture.timestamps) {
          offsets.push(table.offsetMinutesAt(timestamp));
          minutes.push(table.localMinuteOfDay(timestamp));
          dateKeys.push(table.localDateKey(timestamp));
        }

        expect(offsets).toEqual(fixture.offsetMinutes);
        expect(minutes).toEqual(fixture.minuteOfDay);
        expect(dateKeys).toEqual(fixture.dateKey);
      });
    },
  );

  describe('resolveLocal', () => {
    it('reproduces the pandas ambiguous / nonexistent classification', () => {
      const cases = loadGolden<ResolutionFixture[]>('domain', 'local-resolution.json');
      expect(cases.length).toBeGreaterThan(0);

      for (const expected of cases) {
        const table = ZoneOffsetTable.forZone(
          expected.zone,
          Date.UTC(2024, 0, 1),
          Date.UTC(2024, 11, 31),
        );
        const resolved = table.resolveLocal(wallTimeToLocalMs(expected.wallTime));

        expect({ zone: expected.zone, wall: expected.wallTime, kind: resolved.kind }).toEqual({
          zone: expected.zone,
          wall: expected.wallTime,
          kind: expected.kind,
        });

        if (expected.kind === 'nonexistent') {
          expect(resolved.utcMs).toBeNull();
          expect(resolved.shiftForwardUtcMs).toBe(expected.shiftForwardUtc);
        } else {
          expect(resolved.utcMs).toBe(expected.utc);
        }
        if (expected.kind === 'ambiguous') {
          // pandas ambiguous=True keeps DST (the earlier instant),
          // ambiguous=False takes the later one.
          expect(resolved.laterUtcMs).toBe(expected.laterUtc);
        }
      }
    });

    it('round-trips an unambiguous local time', () => {
      const utc = Date.UTC(2024, 5, 3, 6, 0); // 08:00 Berlin, summer
      const local = berlin.toLocalMs(utc);
      expect(berlin.resolveLocal(local)).toMatchObject({ kind: 'unique', utcMs: utc });
    });
  });

  it('derives the local calendar day boundary', () => {
    // 2024-06-03 21:30 UTC is already 2024-06-03 23:30 in Berlin.
    expect(berlin.localDateKey(Date.UTC(2024, 5, 3, 21, 30))).toBe('2024-06-03');
    // 22:30 UTC has rolled over to the 4th locally.
    expect(berlin.localDateKey(Date.UTC(2024, 5, 3, 22, 30))).toBe('2024-06-04');
  });
});
