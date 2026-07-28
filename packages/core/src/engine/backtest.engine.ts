import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { RiskManager } from '../domain/risk-manager';
import { BacktestAdapter, BacktestReport } from '../execution/backtest.adapter';

const DAY_MS = 86_400_000;

export interface BacktestEngineOptions {
  readonly window?: number;
  /**
   * Account-level guard consulted before every order. With one configured,
   * a signal is skipped once the day's realized PnL breaches the manager's
   * daily-drawdown cap — the same idea as freqtrade's protections. Absent
   * (the default), the loop is byte-identical to the unguarded engine.
   */
  readonly riskManager?: RiskManager;
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
  private readonly riskManager: RiskManager | undefined;

  constructor(
    private readonly context: MarketContext,
    private readonly strategy: Strategy,
    private readonly adapter: BacktestAdapter,
    options: BacktestEngineOptions = {},
  ) {
    this.window = options.window ?? 2000;
    this.riskManager = options.riskManager;
  }

  run(baseTimeframe: string): BacktestReport {
    const allCandles = this.context.candles(baseTimeframe);
    const symbol = this.context.symbol;

    // Resolve every timeframe once; re-fetching inside the loop would cost a
    // map lookup per bar per timeframe for nothing.
    const timeframes = [...this.context.timeframes];
    const series: CandleSeries[] = timeframes.map((timeframe) => this.context.candles(timeframe));

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
        if (
          this.riskManager === undefined ||
          this.riskManager.validateSignal(signal, this.adapter.balance, this.dailyPnl(currentTime))
        ) {
          this.adapter.placeOrder(signal);
        }
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

  /** Realized PnL of trades closed on the same UTC day; only computed when a guard is set. */
  private dailyPnl(nowMs: number): number {
    const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    let total = 0;
    for (const trade of this.adapter.trades) {
      if (trade.exitTime !== null && trade.exitTime >= dayStart && trade.exitTime <= nowMs) {
        total += trade.pnlPct ?? 0;
      }
    }
    return total;
  }
}
