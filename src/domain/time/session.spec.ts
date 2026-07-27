import {
  addMinutes,
  compareHourMinute,
  localWallTimeToUtcMs,
  minuteOfDay,
  parseHhMm,
} from './session';
import { ZoneOffsetTable } from './zone-offset-table';

describe('parseHhMm', () => {
  it('parses a session boundary', () => {
    expect(parseHhMm('08:00')).toEqual({ hour: 8, minute: 0 });
    expect(parseHhMm('9:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseHhMm('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it.each(['8', '08', '08:0', '0800', 'ab:cd', '', '08:00:00'])('rejects %p', (value) => {
    expect(() => parseHhMm(value)).toThrow(/must be HH:MM/);
  });

  it.each(['24:00', '25:30', '08:60'])('rejects out-of-range %p', (value) => {
    expect(() => parseHhMm(value)).toThrow(/out of range/);
  });
});

describe('minuteOfDay / addMinutes', () => {
  it('counts minutes since midnight', () => {
    expect(minuteOfDay({ hour: 8, minute: 0 })).toBe(480);
    expect(minuteOfDay({ hour: 0, minute: 0 })).toBe(0);
  });

  it('advances within the same day', () => {
    expect(addMinutes({ hour: 8, minute: 0 }, 60)).toEqual({ hour: 9, minute: 0 });
    expect(addMinutes({ hour: 23, minute: 0 }, 59)).toEqual({ hour: 23, minute: 59 });
  });

  it('refuses to cross midnight', () => {
    expect(() => addMinutes({ hour: 23, minute: 30 }, 30)).toThrow(/must not cross midnight/);
    expect(() => addMinutes({ hour: 8, minute: 0 }, 24 * 60)).toThrow(/must not cross midnight/);
  });

  it('orders wall-clock times', () => {
    expect(compareHourMinute({ hour: 8, minute: 0 }, { hour: 9, minute: 0 })).toBeLessThan(0);
    expect(compareHourMinute({ hour: 9, minute: 0 }, { hour: 9, minute: 0 })).toBe(0);
    expect(compareHourMinute({ hour: 10, minute: 0 }, { hour: 9, minute: 30 })).toBeGreaterThan(0);
  });
});

describe('localWallTimeToUtcMs', () => {
  const berlin = ZoneOffsetTable.forZone(
    'Europe/Berlin',
    Date.UTC(2024, 0, 1),
    Date.UTC(2024, 11, 31),
  );

  it('converts a winter session end', () => {
    // 10:00 Berlin in winter is 09:00 UTC.
    expect(localWallTimeToUtcMs(berlin, '2024-01-15', { hour: 10, minute: 0 })).toBe(
      Date.UTC(2024, 0, 15, 9, 0),
    );
  });

  it('converts a summer session end', () => {
    // 10:00 Berlin in summer is 08:00 UTC.
    expect(localWallTimeToUtcMs(berlin, '2024-06-03', { hour: 10, minute: 0 })).toBe(
      Date.UTC(2024, 5, 3, 8, 0),
    );
  });

  it('throws on a wall time that does not exist, like pd.Timestamp(tz=...)', () => {
    expect(() => localWallTimeToUtcMs(berlin, '2024-03-31', { hour: 2, minute: 30 })).toThrow(
      /does not exist/,
    );
  });

  it('throws on an ambiguous wall time', () => {
    expect(() => localWallTimeToUtcMs(berlin, '2024-10-27', { hour: 2, minute: 30 })).toThrow(
      /ambiguous/,
    );
  });

  it('rejects a malformed date key', () => {
    expect(() => localWallTimeToUtcMs(berlin, '2024/06/03', { hour: 10, minute: 0 })).toThrow(
      /must be YYYY-MM-DD/,
    );
  });

  describe('lenient policies, for derived times such as a session boundary', () => {
    it('shifts a nonexistent wall time to the first real instant', () => {
      // 02:30 Berlin does not exist on 2024-03-31; the clock jumps to 03:00,
      // which is 01:00 UTC.
      expect(
        localWallTimeToUtcMs(
          berlin,
          '2024-03-31',
          { hour: 2, minute: 30 },
          { onNonexistent: 'shiftForward' },
        ),
      ).toBe(Date.UTC(2024, 2, 31, 1, 0));
    });

    it('picks an occurrence for an ambiguous wall time', () => {
      const earlier = localWallTimeToUtcMs(
        berlin,
        '2024-10-27',
        { hour: 2, minute: 30 },
        { onAmbiguous: 'earlier' },
      );
      const later = localWallTimeToUtcMs(
        berlin,
        '2024-10-27',
        { hour: 2, minute: 30 },
        { onAmbiguous: 'later' },
      );

      expect(earlier).toBe(Date.UTC(2024, 9, 27, 0, 30)); // still CEST
      expect(later).toBe(Date.UTC(2024, 9, 27, 1, 30)); // already CET
      expect(later - earlier).toBe(3_600_000);
    });

    it('leaves an ordinary wall time alone', () => {
      const strict = localWallTimeToUtcMs(berlin, '2024-06-03', { hour: 10, minute: 0 });
      const lenient = localWallTimeToUtcMs(
        berlin,
        '2024-06-03',
        { hour: 10, minute: 0 },
        { onNonexistent: 'shiftForward', onAmbiguous: 'earlier' },
      );
      expect(lenient).toBe(strict);
    });
  });
});
