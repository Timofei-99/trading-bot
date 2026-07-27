import { Pattern, PatternType } from './pattern';

const START = Date.UTC(2024, 0, 1);
const JUNE = Date.UTC(2024, 5, 1);

function makePattern(endTime: number | null = null): Pattern {
  return new Pattern({
    type: PatternType.Fvg,
    timeframe: '15m',
    startTime: START,
    endTime,
    high: 50_000,
    low: 49_000,
  });
}

describe('Pattern', () => {
  it('exposes the zone midpoint', () => {
    expect(makePattern().mid).toBe(49_500);
  });

  it('defaults endTime and meta', () => {
    const pattern = makePattern();
    expect(pattern.endTime).toBeNull();
    expect(pattern.meta).toEqual({});
  });

  describe('isActive', () => {
    it('is always active without an end time', () => {
      expect(makePattern(null).isActive(Date.UTC(2025, 0, 1))).toBe(true);
    });

    it('is active before the end time', () => {
      expect(makePattern(JUNE).isActive(Date.UTC(2024, 4, 1))).toBe(true);
    });

    it('is still active exactly at the end time', () => {
      expect(makePattern(JUNE).isActive(JUNE)).toBe(true);
    });

    it('is inactive after the end time', () => {
      expect(makePattern(JUNE).isActive(Date.UTC(2024, 6, 1))).toBe(false);
    });
  });

  it('keeps the wire values of every pattern type', () => {
    expect(PatternType.OrderBlock).toBe('order_block');
    expect(PatternType.Fvg).toBe('fvg');
    expect(PatternType.Liquidity).toBe('liquidity');
    expect(PatternType.Bos).toBe('bos');
    expect(PatternType.Choch).toBe('choch');
    expect(PatternType.PremiumDiscount).toBe('premium_discount');
    expect(PatternType.Killzone).toBe('killzone');
    expect(PatternType.Snr).toBe('snr');
    expect(PatternType.Fractal).toBe('fractal');
    expect(PatternType.InitialBalance).toBe('initial_balance');
  });
});
