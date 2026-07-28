import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Direction } from '../domain/signal';
import { Ob4hFvg15mStrategy } from './ob-4h-fvg-15m.strategy';

const MINUTE_15 = 15 * 60_000;
const HOUR_4 = 4 * 3_600_000;
const START = Date.UTC(2024, 0, 1);

/**
 * Rather than replaying market data, each fixture is built to satisfy exactly
 * the three conditions the strategy needs, so a test can break one of them at
 * a time. The end-to-end behaviour on real bars is covered by
 * `test/parity/strategies-e2e.parity.spec.ts`.
 */

function series(
  opens: number[],
  highs: number[],
  lows: number[],
  closes: number[],
  stepMs: number,
): CandleSeries {
  return CandleSeries.fromBars(
    opens.map(
      (open, i) => [START + i * stepMs, open, highs[i], lows[i], closes[i], 1000] as BarTuple,
    ),
  );
}

/**
 * 14 4h bars holding:
 *   swing low at i=3 (80) and swing high at i=7 (120) -> equilibrium 100
 *   the bar at i=3 is bearish (open 93, close 87) and is the last one before
 *   the swing low, so the bullish order block is [87, 93] with mid 90 — below
 *   the equilibrium, i.e. in discount
 *   nothing ever closes above 93, so the block stays unmitigated
 */
function htfCandles(): CandleSeries {
  return series(
    [105, 100, 95, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93],
    [110, 105, 98, 93, 93, 93, 93, 120, 93, 93, 93, 93, 93, 93],
    [100, 95, 88, 80, 85, 85, 85, 85, 85, 85, 85, 85, 85, 85],
    [108, 98, 90, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87],
    HOUR_4,
  );
}

/**
 * 30 15m bars holding:
 *   a swing low at i=10 (91) swept at i=22 (low 90.5)
 *   a bullish FVG across bars 24-26: [91.5, 93.0], overlapping the block
 *   bar 29 dipping to 92.5, which mitigates that gap on the current bar
 */
function ltfCandles(
  overrides: (o: number[], h: number[], l: number[], c: number[]) => void = () => {},
): CandleSeries {
  const n = 30;
  const opens = Array<number>(n).fill(94);
  const highs = Array<number>(n).fill(96);
  const lows = Array<number>(n).fill(92);
  const closes = Array<number>(n).fill(95);

  for (const i of [7, 8, 9]) {
    opens[i] = 93;
    lows[i] = 92.5;
  }
  opens[10] = 94;
  highs[10] = 95;
  lows[10] = 91; // swing low -> sell-side liquidity
  closes[10] = 94.5;
  for (const i of [11, 12, 13]) {
    lows[i] = 92.5;
  }

  lows[22] = 90.5; // sweeps the 91 level
  closes[22] = 94;

  // Bullish FVG across 24-26: C[24].high 91.5 < C[26].low 93.0.
  opens[24] = 90.5;
  highs[24] = 91.5;
  lows[24] = 90;
  closes[24] = 91;
  opens[25] = 91; // impulse
  highs[25] = 94.5;
  lows[25] = 90.8;
  closes[25] = 94;
  opens[26] = 93.5;
  highs[26] = 95;
  lows[26] = 93;
  closes[26] = 94.5;

  for (const i of [27, 28]) {
    opens[i] = 94;
    highs[i] = 95;
    lows[i] = 93.1; // stays above the gap
    closes[i] = 94.5;
  }

  opens[29] = 94;
  highs[29] = 94.5;
  lows[29] = 92.5; // the current bar mitigates the gap
  closes[29] = 93;

  overrides(opens, highs, lows, closes);
  return series(opens, highs, lows, closes, MINUTE_15);
}

function contextOf(htf: CandleSeries, ltf: CandleSeries): MarketContext {
  const context = new MarketContext('BTCUSDT', ['4h', '15m'], 500);
  context.load('4h', htf);
  context.load('15m', ltf);
  return context;
}

const strategy = (overrides: ConstructorParameters<typeof Ob4hFvg15mStrategy>[0] = {}) =>
  new Ob4hFvg15mStrategy({
    htf: '4h',
    ltf: '15m',
    swingLengthHtf: 3,
    swingLengthLtf: 3,
    ...overrides,
  });

describe('Ob4hFvg15mStrategy', () => {
  describe('with all three conditions met', () => {
    const signal = strategy({ obLookback: 5, liquiditySweepLookback: 20 }).checkEntry(
      contextOf(htfCandles(), ltfCandles()),
    );

    it('emits a long signal', () => {
      expect(signal).not.toBeNull();
      expect(signal?.direction).toBe(Direction.Long);
      expect(signal?.symbol).toBe('BTCUSDT');
      expect(signal?.strategyName).toBe('OB_4h_FVG_15m');
    });

    it('enters at the top of the gap, a level from earlier bars', () => {
      expect(signal?.entry).toBeCloseTo(93, 12);
    });

    it('stops below the order block', () => {
      expect(signal?.stopLoss).toBeCloseTo(87, 12);
    });

    it('targets above the entry', () => {
      expect(signal?.takeProfit).toBeGreaterThan(signal?.entry as number);
    });

    it('labels what triggered it', () => {
      expect(signal?.triggeredBy).toEqual(
        expect.arrayContaining(['4h_ob', '15m_fvg', '15m_ssl_sweep']),
      );
    });

    it('records both zones in meta', () => {
      expect(signal?.meta.ob_zone).toHaveLength(2);
      expect(signal?.meta.fvg_zone).toHaveLength(2);
    });
  });

  it('never targets closer than minRr allows', () => {
    const strat = strategy({ minRr: 3 });
    const signal = strat.checkEntry(contextOf(htfCandles(), ltfCandles()));

    if (signal !== null) {
      expect(signal.takeProfit).toBeGreaterThanOrEqual(
        signal.entry + strat.minRr * signal.riskAmount - 1e-9,
      );
    }
  });

  describe('missing conditions', () => {
    it('needs bars on the lower timeframe', () => {
      const context = new MarketContext('BTCUSDT', ['4h', '15m'], 500);
      context.load('4h', htfCandles());
      context.load('15m', CandleSeries.empty());
      expect(strategy().checkEntry(context)).toBeNull();
    });

    it('needs bars on the higher timeframe', () => {
      const context = new MarketContext('BTCUSDT', ['4h', '15m'], 500);
      context.load('4h', CandleSeries.empty());
      context.load('15m', ltfCandles());
      expect(strategy().checkEntry(context)).toBeNull();
    });

    it('needs a liquidity sweep inside the lookback window', () => {
      // The sweep sits at bar 22; a 4-bar window only reaches back to bar 26.
      expect(
        strategy({ liquiditySweepLookback: 4 }).checkEntry(contextOf(htfCandles(), ltfCandles())),
      ).toBeNull();
    });

    it('needs the gap to be mitigated on the current bar', () => {
      const ltf = ltfCandles((_o, _h, lows) => {
        lows[29] = 93.5; // never reaches down into the gap
      });
      expect(strategy().checkEntry(contextOf(htfCandles(), ltf))).toBeNull();
    });
  });
});
