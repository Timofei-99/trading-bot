import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { BacktestAdapter, BacktestReport } from '../execution/backtest.adapter';

export interface BacktestEngineOptions {
  readonly window?: number;
}

/**
 * Bar-by-bar replay with a fixed-size rolling context window.
 *
 * The outer context holds the full history for every timeframe. On each bar
 * the engine hands the strategy a FRESH context containing, for every
 * timeframe, only the bars whose timestamp is `<= the current bar's time`.
 * The strategy cannot reach future data because it is never given any — this
 * is the migration's central invariant, and it lives here rather than in any
 * strategy.
 *
 * Two conventions follow from that and must not drift:
 *
 *  - Order placement and `adapter.update()` happen on the SAME bar. That
 *    models a resting limit order, which is only sound because `Signal.entry`
 *    is required to be a level derived from earlier bars.
 *  - The slice is an upper bound (`searchSortedRight`), so a higher-timeframe
 *    bar becomes visible at its own open timestamp.
 *
 * `test/parity/engine-visibility.parity.spec.ts` pins both against a trace
 * recorded from the Python engine, and `lookahead-bias.spec.ts` guards the
 * properties directly.
 */
export class BacktestEngine {
  readonly window: number;

  constructor(
    private readonly context: MarketContext,
    private readonly strategy: Strategy,
    private readonly adapter: BacktestAdapter,
    options: BacktestEngineOptions = {},
  ) {
    this.window = options.window ?? 2000;
  }

  run(baseTimeframe: string): BacktestReport {
    const allCandles = this.context.candles(baseTimeframe);
    const symbol = this.context.symbol;

    // Resolve every timeframe once; re-fetching inside the loop would cost a
    // map lookup per bar per timeframe for nothing.
    const timeframes = [...this.context.timeframes];
    const series: CandleSeries[] = timeframes.map((timeframe) =>
      this.context.candles(timeframe),
    );

    for (let i = 0; i < allCandles.length; i++) {
      const currentTime = allCandles.time[i];

      const slice = new MarketContext(symbol, timeframes, this.window);
      for (let t = 0; t < timeframes.length; t++) {
        const visible = series[t].visibleAt(currentTime);
        if (!visible.isEmpty) {
          slice.load(timeframes[t], visible);
        }
      }

      const signal = this.strategy.checkEntry(slice);
      if (signal !== null && this.adapter.getPosition(symbol) === null) {
        this.adapter.placeOrder(signal);
      }

      this.adapter.update(
        symbol,
        allCandles.high[i],
        allCandles.low[i],
        currentTime,
        allCandles.close[i],
      );
    }

    return this.adapter.report();
  }
}
