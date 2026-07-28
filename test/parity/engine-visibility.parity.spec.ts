import { MarketContext } from '@bot/core/domain/market-context';
import { Strategy } from '@bot/core/domain/ports';
import { Signal } from '@bot/core/domain/signal';
import { BacktestEngine } from '@bot/core/engine/backtest.engine';
import { BacktestAdapter } from '@bot/core/execution/backtest.adapter';
import { GoldenVisibilityFile, loadGolden, loadGoldenCandles } from '../fixtures/helpers';

/**
 * What the engine let the strategy see, bar for bar, against a trace recorded
 * from the Python engine.
 *
 * This is the sharpest test of the slicing rule. An off-by-one in
 * `searchSortedRight` would shift every window by one bar — invisible to the
 * unit tests, and it would quietly change which patterns each strategy sees on
 * a year of data.
 */

interface RunSpec {
  run: string;
  symbol: string;
  timeframes: string[];
  datasets: string[];
}

const RUNS: RunSpec[] = [
  {
    run: 'ob4h_fvg15m_btc_2023',
    symbol: 'BTC/USDT',
    timeframes: ['4h', '15m'],
    datasets: ['btc_4h', 'btc_15m'],
  },
  {
    run: 'frankfurt_ib50_synth',
    symbol: 'FDAX',
    timeframes: ['1m'],
    datasets: ['frankfurt_1m'],
  },
  {
    run: 'h1_3m_classic_synth',
    symbol: 'EURUSD=X',
    timeframes: ['1h', '5m'],
    datasets: ['eurusd_1h', 'eurusd_5m'],
  },
];

/** Records what it was shown, on the same bars the Python spy recorded. */
class SpyStrategy extends Strategy {
  readonly name = 'spy';
  readonly version = '0';
  calls = 0;
  readonly trace: {
    call: number;
    visible: Record<string, { count: number; last: number | null; first: number | null }>;
  }[] = [];

  constructor(
    private readonly timeframes: string[],
    private readonly every: number,
  ) {
    super();
  }

  checkEntry(context: MarketContext): Signal | null {
    this.calls += 1;
    if (this.calls === 1 || this.calls % this.every === 0) {
      const visible: Record<string, { count: number; last: number | null; first: number | null }> =
        {};
      for (const timeframe of this.timeframes) {
        const series = context.candles(timeframe);
        visible[timeframe] = {
          count: series.length,
          last: series.lastTime,
          first: series.firstTime,
        };
      }
      this.trace.push({ call: this.calls, visible });
    }
    return null;
  }
}

describe('engine visibility parity with the Python implementation', () => {
  describe.each(RUNS.map((spec) => [spec.run, spec] as const))('%s', (_name, spec) => {
    const golden = loadGolden<GoldenVisibilityFile>('visibility', `${spec.run}.json`);

    const context = new MarketContext(spec.symbol, spec.timeframes, 60_000);
    spec.timeframes.forEach((timeframe, i) => {
      context.load(timeframe, loadGoldenCandles(spec.datasets[i]));
    });

    const base = context.candles(golden.baseTimeframe);
    const spy = new SpyStrategy(spec.timeframes, golden.every);
    new BacktestEngine(context, spy, new BacktestAdapter(), { window: golden.window }).run(
      golden.baseTimeframe,
    );

    it('calls the strategy once per bar of the base timeframe', () => {
      expect(spy.calls).toBe(golden.totalCalls);
      expect(spy.calls).toBe(base.length);
    });

    it('records the same number of sample points', () => {
      expect(spy.trace).toHaveLength(golden.trace.length);
      expect(golden.trace.length).toBeGreaterThan(10);
    });

    it('shows exactly the same window at every sample point', () => {
      golden.trace.forEach((expected, i) => {
        expect({ call: spy.trace[i].call, visible: spy.trace[i].visible }).toEqual({
          call: expected.call,
          visible: expected.visible,
        });
      });
    });

    it('never exposes a bar past the current one, on any timeframe', () => {
      for (const entry of golden.trace) {
        const barTime = entry.barTime;
        expect(base.time[entry.call - 1]).toBe(barTime);
        for (const window of Object.values(entry.visible)) {
          if (window.last !== null) {
            expect(window.last).toBeLessThanOrEqual(barTime);
          }
        }
      }
    });
  });
});
