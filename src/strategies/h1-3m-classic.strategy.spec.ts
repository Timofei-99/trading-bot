import { loadGoldenCandles } from '../../test/fixtures/helpers';
import { MarketContext } from '../domain/market-context';
import { Signal } from '../domain/signal';
import { BacktestEngine } from '../engine/backtest.engine';
import { BacktestAdapter } from '../execution/backtest.adapter';
import { H1m3mClassicOptions, H1m3mClassicStrategy } from './h1-3m-classic.strategy';

/**
 * The Python implementation shipped without tests for this strategy — it was
 * only ever exercised by running `run_backtest_1h3m.py` against live Yahoo
 * data. These drive the deterministic EURUSD fixture through the engine and
 * pin each decision branch by varying one parameter at a time.
 *
 * The fixture is shaped so a setup forms every weekday: a 1h fractal low at
 * 03:35 UTC, swept by the 06:00 bar, then a 5m break of structure inside the
 * 06:00-09:00 entry window. Mondays fall out because the 48-hour context
 * window has fewer than 10 bars behind them.
 */

function runStrategy(options: H1m3mClassicOptions = {}): Signal[] {
  const context = new MarketContext('EURUSD=X', ['1h', '5m'], 60_000);
  context.load('1h', loadGoldenCandles('eurusd_1h'));
  context.load('5m', loadGoldenCandles('eurusd_5m'));

  const strategy = new H1m3mClassicStrategy({ symbol: 'EURUSD=X', ...options });
  const adapter = new BacktestAdapter({ initialBalance: 10_000, riskPerTrade: 0.01 });
  new BacktestEngine(context, strategy, adapter, { window: 500 }).run('5m');

  return [...adapter.trades, ...adapter.openTrades].map((trade) => trade.signal);
}

describe('H1m3mClassicStrategy', () => {
  describe('on the reference fixture', () => {
    const signals = runStrategy();

    it('takes one setup per qualifying day', () => {
      expect(signals).toHaveLength(9);
      const days = signals.map((s) => new Date(s.timestamp).toISOString().slice(0, 10));
      expect(new Set(days).size).toBe(signals.length);
    });

    it('enters only inside the 06:00-09:00 UTC window', () => {
      for (const signal of signals) {
        const hour = new Date(signal.timestamp).getUTCHours();
        expect(hour).toBeGreaterThanOrEqual(6);
        expect(hour).toBeLessThan(9);
      }
    });

    it('stops at the sweep bar wick, below the entry for a long', () => {
      for (const signal of signals) {
        expect(signal.stopLoss).toBeLessThan(signal.entry);
        expect(signal.takeProfit).toBeGreaterThan(signal.entry);
      }
    });

    it('records the context and levels it acted on', () => {
      for (const signal of signals) {
        expect(signal.meta.context).toBe('BULLISH');
        expect(signal.meta.fractal_level).toEqual(expect.any(Number));
        expect(signal.meta.pre_sweep_ref).toEqual(expect.any(Number));
        expect(signal.meta.pdh).toEqual(expect.any(Number));
        expect(signal.triggeredBy).toEqual(['1h_fractal_sweep', '5m_bos']);
      }
    });
  });

  describe('context gate', () => {
    it('trades nothing when the drift never clears the threshold', () => {
      // The fixture drifts ~90 pips a day; demanding 10 000 makes every day RANGE.
      expect(runStrategy({ contextThresholdPips: 10_000 })).toHaveLength(0);
    });

    it('still trades when the threshold is trivially small', () => {
      expect(runStrategy({ contextThresholdPips: 1 })).toHaveLength(9);
    });
  });

  describe('risk gate', () => {
    it('skips setups whose stop is wider than maxStopPips', () => {
      // The stops here run ~33 pips.
      expect(runStrategy({ maxStopPips: 5 })).toHaveLength(0);
    });

    it('keeps setups once the stop fits', () => {
      expect(runStrategy({ maxStopPips: 50 })).toHaveLength(9);
    });
  });

  describe('target selection', () => {
    it('takes the previous day high when it pays at least minRr', () => {
      const signals = runStrategy();
      // pdh sits above entry and the reward beats 1.3R, so it is the target.
      for (const signal of signals) {
        expect(signal.takeProfit).toBe(signal.meta.pdh);
      }
    });

    it('falls back to an RR multiple when that target is too close', () => {
      const minRr = 10;
      const signals = runStrategy({ minRr });
      expect(signals.length).toBeGreaterThan(0);

      for (const signal of signals) {
        expect(signal.takeProfit).not.toBe(signal.meta.pdh);
        expect(signal.takeProfit).toBeCloseTo(signal.entry + signal.riskAmount * minRr, 12);
      }
    });
  });

  it('is inert without any higher-timeframe history', () => {
    const context = new MarketContext('EURUSD=X', ['1h', '5m'], 60_000);
    context.load('5m', loadGoldenCandles('eurusd_5m').head(10));
    expect(new H1m3mClassicStrategy().checkEntry(context)).toBeNull();
  });
});
