import { CandleSeries } from '../domain/candle-series';
import { dailyRealizedPnl, KillSwitch } from '../domain/kill-switch';
import { MarketContext, TIMEFRAME_MINUTES } from '../domain/market-context';
import { TradeJournalPort } from '../domain/order';
import { LiveExecutionPort, MarketDataPort, Strategy } from '../domain/ports';
import { RiskManager } from '../domain/risk-manager';
import { Signal } from '../domain/signal';

/** Injectable time source, so the loop is testable without a wall clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface LiveEngineOptions {
  readonly symbol: string;
  readonly timeframes: readonly string[];
  readonly baseTimeframe: string;
  /** Rolling context window per timeframe, same meaning as in the backtest. */
  readonly window?: number;
  /** Wait after a candle boundary before fetching, letting the venue finalize the bar. */
  readonly graceMs?: number;
  readonly riskManager?: RiskManager;
  /** Account-level stop that outranks the strategy and survives restarts. */
  readonly killSwitch?: KillSwitch;
  /** Where a halt is recorded, so a restart replays it. */
  readonly journal?: TradeJournalPort;
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

export interface TickResult {
  /** The closed bar this tick acted on, or null when nothing new had closed. */
  readonly processedBar: number | null;
  readonly placedEntry: boolean;
  readonly closedTrades: number;
  /** Set on the tick where the kill switch tripped. */
  readonly halted?: string;
}

/**
 * The live counterpart of `BacktestEngine`: instead of iterating history, it
 * waits for each base-timeframe candle to CLOSE and then runs the exact same
 * sequence — settle the bar, then let the strategy see a context that ends on
 * it.
 *
 * The single most important rule here is the one DIY bots break: the strategy
 * must never see a forming candle. Exchanges return the current, still-open
 * candle as the last element of an OHLCV fetch; every series that enters the
 * context is filtered to bars whose CLOSE time has passed (`open + tf <= now`).
 * The look-ahead guarantee of the backtest carries over to live unchanged —
 * the context handed to the strategy simply cannot contain the future, or
 * even the unfinished present.
 *
 * One deliberate ordering difference from the backtest: live settles the bar
 * (fills, TP/SL) BEFORE the strategy runs, because in reality those fills
 * happened during the bar, while the strategy only wakes at its close.
 */
export class LiveEngine {
  readonly symbol: string;
  readonly timeframes: readonly string[];
  readonly baseTimeframe: string;
  readonly window: number;
  readonly graceMs: number;

  private readonly riskManager: RiskManager | undefined;
  private readonly killSwitch: KillSwitch | undefined;
  private readonly journal: TradeJournalPort | undefined;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;

  private readonly series = new Map<string, CandleSeries>();
  private lastProcessed: number | null = null;
  private running = false;

  constructor(
    private readonly data: MarketDataPort,
    private readonly strategy: Strategy,
    private readonly adapter: LiveExecutionPort,
    options: LiveEngineOptions,
  ) {
    this.symbol = options.symbol;
    this.timeframes = options.timeframes;
    this.baseTimeframe = options.baseTimeframe;
    this.window = options.window ?? 500;
    this.graceMs = options.graceMs ?? 3_000;
    this.riskManager = options.riskManager;
    this.killSwitch = options.killSwitch;
    this.journal = options.journal;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.log = options.log ?? (() => undefined);

    // A halt recorded before the process died must still be in force.
    if (this.killSwitch !== undefined && this.journal !== undefined) {
      for (const event of this.journal.readAll()) {
        if (event.type === 'halted') {
          this.killSwitch.halt(event.reason);
        } else if (event.type === 'resumed') {
          this.killSwitch.resume();
        }
      }
      if (this.killSwitch.isHalted) {
        this.log(`HALTED (restored): ${this.killSwitch.reason}`);
      }
    }

    for (const timeframe of this.timeframes) {
      this.timeframeMs(timeframe); // validate configuration up front
    }
  }

  // -------------------------------------------------------------------------

  /** Preload enough closed history for every timeframe's rolling window. */
  async warmup(nowMs: number): Promise<void> {
    for (const timeframe of this.timeframes) {
      const tfMs = this.timeframeMs(timeframe);
      const fetched = await this.data.getCandles({
        symbol: this.symbol,
        timeframe,
        startMs: nowMs - (this.window + 1) * tfMs,
        endMs: nowMs,
      });
      const closed = this.closedOnly(fetched, timeframe, nowMs);
      this.series.set(timeframe, closed);
      this.log(
        `warmup ${timeframe}: ${closed.length} closed bars` +
          (closed.lastTime === null ? '' : `, last ${new Date(closed.lastTime).toISOString()}`),
      );
    }
    const base = this.series.get(this.baseTimeframe);
    this.lastProcessed = base?.lastTime ?? null;
  }

  /** One full iteration; the heart of the loop, called by `start()` and by tests. */
  async tick(nowMs: number): Promise<TickResult> {
    await this.refresh(nowMs);

    const base = this.series.get(this.baseTimeframe);
    if (base === undefined || base.isEmpty) {
      return { processedBar: null, placedEntry: false, closedTrades: 0 };
    }
    const currentTime = base.lastTime as number;
    if (this.lastProcessed !== null && currentTime <= this.lastProcessed) {
      return { processedBar: null, placedEntry: false, closedTrades: 0 };
    }

    // The same containment rule as the backtest engine: every timeframe is
    // cut at the current bar's timestamp.
    const context = new MarketContext(this.symbol, [...this.timeframes], this.window);
    for (const timeframe of this.timeframes) {
      const visible = (this.series.get(timeframe) as CandleSeries).visibleAt(currentTime);
      if (!visible.isEmpty) {
        context.load(timeframe, visible);
      }
    }

    const lastBar = base.candleAt(base.length - 1);
    const syncResult = await this.adapter.sync({ symbol: this.symbol, candle: lastBar });
    for (const trade of syncResult.closed) {
      this.log(
        `closed ${trade.exitReason} @ ${trade.exitPrice} ` +
          `(pnl ${((trade.pnlPct ?? 0) * 100).toFixed(3)}%)`,
      );
    }
    for (const order of syncResult.settledEntries) {
      if (order.status !== 'filled') {
        this.log(`entry ${order.status}: ${order.orderId}`);
      } else {
        this.log(`entry filled @ ${order.fillPrice}`);
      }
    }

    // Evaluate the account-level stop against what just closed, before
    // considering any new entry.
    const halted = await this.enforceKillSwitch(currentTime);

    let placedEntry = false;
    const position = await this.adapter.getPosition(this.symbol);
    if (position !== null) {
      if (this.strategy.checkExit(context, position)) {
        await this.adapter.closePosition(this.symbol, 'strategy');
        this.log('strategy exit: position closed');
      }
    } else if (
      this.killSwitch?.isHalted !== true &&
      (await this.adapter.getRestingEntry(this.symbol)) === null
    ) {
      const signal = this.strategy.checkEntry(context);
      if (signal !== null && (await this.riskAllows(signal, currentTime))) {
        const order = await this.adapter.placeEntry(signal);
        placedEntry = true;
        this.log(
          `entry placed: ${signal.direction} ${signal.symbol} @ ${signal.entry} ` +
            `(sl ${signal.stopLoss}, tp ${signal.takeProfit}, size ${order.positionSize.toFixed(8)})`,
        );
      }
    }

    this.lastProcessed = currentTime;
    return {
      processedBar: currentTime,
      placedEntry,
      closedTrades: syncResult.closed.length,
      ...(halted === null ? {} : { halted }),
    };
  }

  /**
   * Trip the kill switch if the account has had enough for today.
   *
   * Halting cancels a resting entry — an order we placed but that has not
   * filled is still ours to withdraw — but leaves an open position alone:
   * its stop is already at the venue, and selling at market on the way out
   * would realize a loss the stop might never have taken.
   */
  private async enforceKillSwitch(nowMs: number): Promise<string | null> {
    if (this.killSwitch === undefined || this.killSwitch.isHalted) {
      return null;
    }
    const closed = await this.adapter.getClosedTrades();
    const reason = this.killSwitch.evaluate(closed, nowMs);
    if (reason === null) {
      return null;
    }

    this.killSwitch.halt(reason);
    this.journal?.append({ type: 'halted', at: nowMs, reason });
    this.log(`HALTED: ${reason} — no new entries until resumed`);

    const resting = await this.adapter.getRestingEntry(this.symbol);
    if (resting !== null) {
      await this.adapter.cancelEntry(this.symbol);
      this.log(`HALTED: cancelled resting entry ${resting.orderId}`);
    }
    const position = await this.adapter.getPosition(this.symbol);
    if (position !== null) {
      this.log('HALTED: an open position remains; its exits stay at the venue');
    }
    return reason;
  }

  /** Run until `stop()`: tick, then sleep to just past the next base-bar close. */
  async start(): Promise<void> {
    this.running = true;
    await this.warmup(this.clock.now());
    const baseMs = this.timeframeMs(this.baseTimeframe);

    while (this.running) {
      try {
        await this.tick(this.clock.now());
      } catch (error) {
        // A single network hiccup must not kill the loop; the next candle
        // retries naturally. (Structured retry/backoff arrives with the
        // venue adapter.)
        this.log(`tick failed, retrying next cycle: ${(error as Error).message}`);
      }
      if (!this.running) {
        break;
      }
      const now = this.clock.now();
      const nextClose = Math.floor(now / baseMs) * baseMs + baseMs;
      await this.clock.sleep(Math.max(nextClose + this.graceMs - now, 1_000));
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Observability for logs and tests. */
  lastClosedTime(timeframe: string): number | null {
    return this.series.get(timeframe)?.lastTime ?? null;
  }

  barsLoaded(timeframe: string): number {
    return this.series.get(timeframe)?.length ?? 0;
  }

  // -------------------------------------------------------------------------

  /** Fetch what is new per timeframe and merge, keeping memory bounded. */
  private async refresh(nowMs: number): Promise<void> {
    for (const timeframe of this.timeframes) {
      const tfMs = this.timeframeMs(timeframe);
      const known = this.series.get(timeframe) ?? CandleSeries.empty();
      const startMs = known.lastTime === null ? nowMs - (this.window + 1) * tfMs : known.lastTime;

      const fetched = await this.data.getCandles({
        symbol: this.symbol,
        timeframe,
        startMs,
        endMs: nowMs,
      });
      const closed = this.closedOnly(fetched, timeframe, nowMs);
      if (closed.isEmpty) {
        continue;
      }
      this.series.set(timeframe, CandleSeries.mergeDedupe([known, closed]).tail(this.window * 2));
    }
  }

  /**
   * Drop anything not yet closed: a bar opened at T on timeframe D is closed
   * once `T + D <= now`. This is what keeps the forming candle out.
   */
  private closedOnly(candles: CandleSeries, timeframe: string, nowMs: number): CandleSeries {
    return candles.visibleAt(nowMs - this.timeframeMs(timeframe));
  }

  private async riskAllows(signal: Signal, nowMs: number): Promise<boolean> {
    if (this.riskManager === undefined) {
      return true;
    }
    const dailyPnl = dailyRealizedPnl(await this.adapter.getClosedTrades(), nowMs);
    const allowed = this.riskManager.validateSignal(
      signal,
      await this.adapter.getBalance(),
      dailyPnl,
    );
    if (!allowed) {
      this.log(`risk gate: entry skipped (daily pnl ${(dailyPnl * 100).toFixed(2)}%)`);
    }
    return allowed;
  }

  private timeframeMs(timeframe: string): number {
    const minutes = TIMEFRAME_MINUTES[timeframe];
    if (minutes === undefined) {
      throw new Error(`Unknown timeframe: ${timeframe}`);
    }
    return minutes * 60_000;
  }
}
