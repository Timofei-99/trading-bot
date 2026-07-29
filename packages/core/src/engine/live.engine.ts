import { Candle, CandleSeries } from '../domain/candle-series';
import { dailyRealizedPnl, KillSwitch } from '../domain/kill-switch';
import { MarketContext, TIMEFRAME_MINUTES } from '../domain/market-context';
import { SyncResult, TradeJournalPort } from '../domain/order';
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

    this.restoreFromJournal();

    for (const timeframe of this.timeframes) {
      this.timeframeMs(timeframe); // validate configuration up front
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Rebuild everything the previous process knew: whether it was halted, and
   * which bar it last ran to completion.
   *
   * One pass over the journal in order, because both facts are last-write-wins
   * and a second pass would only be a second chance to disagree.
   */
  private restoreFromJournal(): void {
    if (this.journal === undefined) {
      return;
    }

    for (const event of this.journal.readAll()) {
      if (event.type === 'halted') {
        this.killSwitch?.halt(event.reason);
      } else if (event.type === 'resumed') {
        this.killSwitch?.resume();
      } else if (event.type === 'bar_processed' && event.symbol === this.symbol) {
        this.lastProcessed = event.barTime;
      }
    }

    if (this.killSwitch?.isHalted === true) {
      this.log(`HALTED (restored): ${this.killSwitch.reason}`);
    }
    if (this.lastProcessed !== null) {
      this.log(`restored: last processed bar ${new Date(this.lastProcessed).toISOString()}`);
    }
  }

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
    // A FIRST start must not act on bars that closed before the process
    // existed, so it marks the newest one as already handled. A RESTART must
    // not do that: the journal already says where it got to, and overwriting
    // that here is exactly how settlement of a bar that closed during the
    // outage went missing.
    if (this.lastProcessed === null) {
      const base = this.series.get(this.baseTimeframe);
      this.lastProcessed = base?.lastTime ?? null;
    }
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

    // Settle every bar that closed since the last completed tick, not just the
    // newest one. Normally that is exactly one bar; after a restart or a
    // stalled loop it is however many were missed, and skipping them would
    // lose a take-profit or a stop that traded during the gap.
    //
    // Only settlement is replayed. The strategy's ENTRY decision runs once, on
    // the newest bar, because acting on a signal from a bar that closed
    // minutes ago is not the same trade the strategy meant to take.
    const caughtUp = await this.settleMissedBars(base, currentTime);
    const syncResult = await this.settle(base.candleAt(base.length - 1));
    const closedTrades = caughtUp + syncResult.closed.length;

    // The same containment rule as the backtest engine: every timeframe is
    // cut at the current bar's timestamp.
    const context = new MarketContext(this.symbol, [...this.timeframes], this.window);
    for (const timeframe of this.timeframes) {
      const visible = (this.series.get(timeframe) as CandleSeries).visibleAt(currentTime);
      if (!visible.isEmpty) {
        context.load(timeframe, visible);
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

    // Written LAST, and only on a tick that ran to completion. A crash before
    // this point leaves the bar unrecorded, so the restart settles it again —
    // which is safe, because settlement is idempotent and the entry it might
    // re-place carries the same deterministic id the venue already knows.
    this.lastProcessed = currentTime;
    this.journal?.append({
      type: 'bar_processed',
      at: nowMs,
      symbol: this.symbol,
      barTime: currentTime,
    });

    return {
      processedBar: currentTime,
      placedEntry,
      closedTrades,
      ...(halted === null ? {} : { halted }),
    };
  }

  /**
   * Settle the bars strictly between the last completed tick and the current
   * one. Returns how many trades closed while catching up.
   *
   * Bounded by the rolling window the engine keeps, so an outage of any length
   * replays at most that many bars rather than the whole history.
   */
  private async settleMissedBars(base: CandleSeries, currentTime: number): Promise<number> {
    if (this.lastProcessed === null) {
      return 0;
    }

    const missed: Candle[] = [];
    for (let i = base.length - 1; i >= 0; i--) {
      const candle = base.candleAt(i);
      if (candle.time >= currentTime || candle.time <= this.lastProcessed) {
        continue;
      }
      missed.unshift(candle);
    }
    if (missed.length === 0) {
      return 0;
    }

    this.log(`catching up: settling ${missed.length} bar(s) missed since the last completed tick`);
    let closed = 0;
    for (const candle of missed) {
      closed += (await this.settle(candle)).closed.length;
    }
    return closed;
  }

  /** Hand one closed bar to the adapter and narrate what it settled. */
  private async settle(candle: Candle): Promise<SyncResult> {
    const result = await this.adapter.sync({ symbol: this.symbol, candle });

    for (const trade of result.closed) {
      this.log(
        `closed ${trade.exitReason} @ ${trade.exitPrice} ` +
          `(pnl ${((trade.pnlPct ?? 0) * 100).toFixed(3)}%)`,
      );
    }
    for (const order of result.settledEntries) {
      this.log(
        order.status === 'filled'
          ? `entry filled @ ${order.fillPrice}`
          : `entry ${order.status}: ${order.orderId}`,
      );
    }
    return result;
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

  /**
   * The newest bar this engine ran to completion, restored from the journal on
   * startup. `null` means it has not finished one yet.
   */
  get lastCompletedBar(): number | null {
    return this.lastProcessed;
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
