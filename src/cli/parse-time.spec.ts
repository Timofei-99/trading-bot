import { assertRange, parseInstant, parseMonth } from './parse-time';

describe('parseInstant', () => {
  it('reads a bare date as UTC midnight', () => {
    expect(parseInstant('2023-06-01', '--start')).toBe(Date.UTC(2023, 5, 1));
  });

  it('accepts an explicit UTC instant', () => {
    expect(parseInstant('2023-06-01T12:30:00Z', '--start')).toBe(Date.UTC(2023, 5, 1, 12, 30));
  });

  it('accepts an explicit offset', () => {
    expect(parseInstant('2023-06-01T12:30:00+02:00', '--start')).toBe(
      Date.UTC(2023, 5, 1, 10, 30),
    );
  });

  it('rejects a time without a zone, naming the fix', () => {
    // Date.parse would have read this in the machine's local zone and quietly
    // shifted the whole backtest range.
    expect(() => parseInstant('2023-06-01T00:00:00', '--start')).toThrow(
      /--start:.*has no timezone.*Append "Z".*2023-06-01T00:00:00Z/s,
    );
  });

  it('rejects an unparseable value instead of passing NaN downstream', () => {
    expect(() => parseInstant('nonsense', '--start')).toThrow(/--start: cannot read "nonsense"/);
    expect(() => parseInstant('', '--end')).toThrow(/--end: cannot read/);
  });

  it('rejects a date that does not exist', () => {
    // Date.parse would have rolled these over to 2023-03-02 and 2024-03-01,
    // moving the range by days without a word.
    expect(() => parseInstant('2023-02-30T00:00:00Z', '--start')).toThrow(/is not a real date/);
    expect(() => parseInstant('2023-02-30', '--start')).toThrow(/is not a real date/);
    expect(() => parseInstant('2023-02-29', '--start')).toThrow(/is not a real date/);
  });

  it('accepts a real leap day', () => {
    expect(parseInstant('2024-02-29', '--start')).toBe(Date.UTC(2024, 1, 29));
  });

  it('is not fooled by surrounding whitespace', () => {
    expect(parseInstant('  2023-06-01  ', '--start')).toBe(Date.UTC(2023, 5, 1));
  });
});

describe('parseMonth', () => {
  it('returns the half-open UTC range of the month', () => {
    expect(parseMonth('2023-02', '--chart-month')).toEqual({
      startMs: Date.UTC(2023, 1, 1),
      endMs: Date.UTC(2023, 2, 1),
    });
  });

  it('handles a year boundary', () => {
    expect(parseMonth('2023-12', '--chart-month').endMs).toBe(Date.UTC(2024, 0, 1));
  });

  it.each(['2023', '2023-13', '23-02', 'февраль'])('rejects %p', (value) => {
    expect(() => parseMonth(value, '--chart-month')).toThrow(/--chart-month/);
  });
});

describe('assertRange', () => {
  it('accepts a forward range', () => {
    expect(() => assertRange(0, 1)).not.toThrow();
  });

  it('rejects a reversed or empty one', () => {
    expect(() => assertRange(1, 0)).toThrow(/must be before/);
    expect(() => assertRange(5, 5)).toThrow(/must be before/);
  });
});
