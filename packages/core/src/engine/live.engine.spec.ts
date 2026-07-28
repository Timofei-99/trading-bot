import { BarTuple, CandleSeries } from '../domain/candle-series';
import { KillSwitch } from '../domain/kill-switch';
import { MarketContext } from '../domain/market-context';
import { JournalEvent, TradeJournalPort } from '../domain/order';
import { CandleRequest, MarketDataPort, Strategy } from '../domain/ports';
import { RiskManager } from '../domain/risk-manager';
import { Direction, Signal } from '../domain/signal';
import { Trade } from '../domain/trade';
import { PaperAdapter } from '../execution/paper.adapter';
import { LiveEngine } from './live.engine';

const SYMBOL = 'BTC/USDT';
const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number): number => T0 + i * M15;

/** Serves a scripted series; what a venue's OHLCV endpoint would return. */
class ScriptedData implements MarketDataPort {
  readonly requests: CandleRequest[] = [];
  constructor(private readonly byTimeframe: Record<string, CandleSeries>) {}

  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    this.requests.push(request);
    const series = this.byTimeframe[request.timeframe];
    if (series === undefined) {
      return CandleSeries.empty();
    }
    return series.between(request.startMs, request.endMs);
  }
}

/** Fires one long at a configured bar time; records what it was shown. */
class OneShotStrategy extends Strategy {
  readonly name = 'one-shot';
  readonly version = '0';
  readonly seenLastBars: number[] = [];
  exitOn: number | null = null;
  private fired = false;

  constructor(
    private readonly triggerTime: number,
    // The target sits above the 101 highs of the background bars, so nothing
    // fills or exits until the script says so.
    private readonly levels = { entry: 98, stopLoss: 95, takeProfit: 102 },
  ) {
    super();
  }

  checkEntry(context: MarketContext): Signal | null {
    const series = context.candles('15m');
    if (series.isEmpty) {
      return null;
    }
    this.seenLastBars.push(series.lastTime as number);
    if (this.fired || series.lastTime !== this.triggerTime) {
      return null;
    }
    this.fired = true;
    return new Signal({
      symbol: SYMBOL,
      direction: Direction.Long,
      entry: this.levels.entry,
      stopLoss: this.levels.stopLoss,
      takeProfit: this.levels.takeProfit,
      timeframe: '15m',
      timestamp: series.lastTime as number,
      strategyName: this.name,
      strategyVersion: this.version,
    });
  }

  override checkExit(_context: MarketContext, trade: Trade): boolean {
    return this.exitOn !== null && trade.entryTime <= this.exitOn;
  }
}

/** Signals on every bar, so a fresh entry can be resting when a loss lands. */
class AlwaysSignalStrategy extends Strategy {
  readonly name = 'always';
  readonly version = '0';

  checkEntry(context: MarketContext): Signal | null {
    const series = context.candles('15m');
    if (series.isEmpty) {
      return null;
    }
    return new Signal({
      symbol: SYMBOL,
      direction: Direction.Long,
      entry: 98,
      stopLoss: 95,
      takeProfit: 102,
      timeframe: '15m',
      timestamp: series.lastTime as number,
      strategyName: this.name,
      strategyVersion: this.version,
    });
  }
}

/** In-memory journal double. */
class MemoryJournal implements TradeJournalPort {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  readAll(): JournalEvent[] {
    return [...this.events];
  }
}

/** rows[i] = [high, low]; open/close sit mid-range. */
function series(rows: [number, number][]): CandleSeries {
  return CandleSeries.fromBars(
    rows.map(([high, low], i) => {
      const mid = (high + low) / 2;
      return [bar(i), mid, high, low, mid, 1000] as BarTuple;
    }),
  );
}

const flatBars = (n: number): [number, number][] =>
  Array.from({ length: n }, () => [101, 99] as [number, number]);

function engineWith(
  data: MarketDataPort,
  strategy: Strategy,
  adapter: PaperAdapter,
  riskManager?: RiskManager,
): LiveEngine {
  return new LiveEngine(data, strategy, adapter, {
    symbol: SYMBOL,
    timeframes: ['15m'],
    baseTimeframe: '15m',
    window: 100,
    riskManager,
  });
}

describe('LiveEngine', () => {
  describe('the forming candle stays invisible', () => {
    it('drops the unclosed bar during warmup', async () => {
      const data = new ScriptedData({ '15m': series(flatBars(10)) });
      const engine = engineWith(data, new OneShotStrategy(bar(99)), new PaperAdapter());

      // Seven minutes into bar 9: bars 0..8 are closed, bar 9 is forming.
      await engine.warmup(bar(9) + 7 * 60_000);

      expect(engine.barsLoaded('15m')).toBe(9);
      expect(engine.lastClosedTime('15m')).toBe(bar(8));
    });

    it('never shows the strategy a bar whose close has not passed', async () => {
      const data = new ScriptedData({ '15m': series(flatBars(10)) });
      const strategy = new OneShotStrategy(bar(99));
      const engine = engineWith(data, strategy, new PaperAdapter());

      await engine.warmup(bar(9) + 7 * 60_000);
      await engine.tick(bar(9) + 8 * 60_000); // still inside bar 9
      await engine.tick(bar(9) + M15 + 1_000); // bar 9 has now closed

      expect(strategy.seenLastBars).toEqual([bar(9)]);
    });
  });

  it('processes each closed bar exactly once', async () => {
    const data = new ScriptedData({ '15m': series(flatBars(6)) });
    const strategy = new OneShotStrategy(bar(99));
    const engine = engineWith(data, strategy, new PaperAdapter());

    await engine.warmup(bar(4) + 1_000);
    const first = await engine.tick(bar(4) + M15 + 1_000);
    const again = await engine.tick(bar(4) + M15 + 2_000);

    expect(first.processedBar).toBe(bar(4));
    expect(again.processedBar).toBeNull();
    expect(strategy.seenLastBars).toEqual([bar(4)]);
  });

  it('runs the full flow: signal → resting entry → fill → take profit', async () => {
    const rows = flatBars(10);
    rows[5] = [100, 97.5]; // touches the 98 limit, stays below the target
    rows[6] = [102.5, 99]; // touches the 102 target
    const data = new ScriptedData({ '15m': series(rows) });
    const strategy = new OneShotStrategy(bar(4));
    const adapter = new PaperAdapter();
    const engine = engineWith(data, strategy, adapter);

    await engine.warmup(bar(4) + 1_000);

    const signalTick = await engine.tick(bar(4) + M15 + 1_000);
    expect(signalTick.placedEntry).toBe(true);
    expect((await adapter.getRestingEntry(SYMBOL))?.signal.entry).toBe(98);

    const fillTick = await engine.tick(bar(5) + M15 + 1_000);
    expect(fillTick.closedTrades).toBe(0);
    expect((await adapter.getPosition(SYMBOL))?.entryPrice).toBe(98);
    expect((await adapter.getPosition(SYMBOL))?.entryTime).toBe(bar(5));

    const exitTick = await engine.tick(bar(6) + M15 + 1_000);
    expect(exitTick.closedTrades).toBe(1);
    const closed = await adapter.getClosedTrades();
    expect(closed[0].exitReason).toBe('tp');
    expect(closed[0].exitPrice).toBe(102);
  });

  it('wires checkExit: the strategy can close a live position', async () => {
    const rows = flatBars(10);
    rows[5] = [100, 97.5]; // fill
    const data = new ScriptedData({ '15m': series(rows) });
    const strategy = new OneShotStrategy(bar(4));
    const adapter = new PaperAdapter();
    const engine = engineWith(data, strategy, adapter);

    await engine.warmup(bar(4) + 1_000);
    await engine.tick(bar(4) + M15 + 1_000); // entry placed
    await engine.tick(bar(5) + M15 + 1_000); // filled

    strategy.exitOn = bar(9); // exit whatever is open
    await engine.tick(bar(6) + M15 + 1_000);

    expect(await adapter.getPosition(SYMBOL)).toBeNull();
    const closed = await adapter.getClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('strategy');
  });

  it('does not stack a second signal while an entry rests', async () => {
    // The strategy would fire again, but the engine must not ask it while an
    // order rests: no touch ever happens, so the entry just sits.
    const data = new ScriptedData({ '15m': series(flatBars(10)) });
    const strategy = new OneShotStrategy(bar(4));
    const adapter = new PaperAdapter({ entryTimeoutMs: 100 * M15 });
    const engine = engineWith(data, strategy, adapter);

    await engine.warmup(bar(4) + 1_000);
    await engine.tick(bar(4) + M15 + 1_000);
    const callsAfterPlacement = strategy.seenLastBars.length;
    await engine.tick(bar(5) + M15 + 1_000);
    await engine.tick(bar(6) + M15 + 1_000);

    expect(strategy.seenLastBars.length).toBe(callsAfterPlacement);
    expect(await adapter.getRestingEntry(SYMBOL)).not.toBeNull();
  });

  it('lets the risk gate veto an entry', async () => {
    const data = new ScriptedData({ '15m': series(flatBars(10)) });
    const strategy = new OneShotStrategy(bar(4));
    const adapter = new PaperAdapter();
    // A cap of -0 is breached by any non-positive daily pnl? No: dailyPnl of 0
    // >= -0 passes. Use a manager whose cap is impossible to satisfy by
    // pre-seeding a big same-day loss instead.
    const journalFree = adapter as unknown as {
      closedTrades: Trade[];
    };
    journalFree.closedTrades.push(
      (() => {
        const trade = new Trade({
          signal: new Signal({
            symbol: SYMBOL,
            direction: Direction.Long,
            entry: 100,
            stopLoss: 90,
            takeProfit: 110,
            timeframe: '15m',
            timestamp: bar(0),
            strategyName: 's',
            strategyVersion: '0',
          }),
          orderId: 'seed',
          entryTime: bar(0),
          entryPrice: 100,
          positionSize: 1,
        });
        trade.exitPrice = 90; // -10% today
        trade.exitTime = bar(1);
        trade.exitReason = 'sl';
        return trade;
      })(),
    );
    const engine = engineWith(data, strategy, adapter, new RiskManager(0.01, 0.05));

    await engine.warmup(bar(4) + 1_000);
    const tick = await engine.tick(bar(4) + M15 + 1_000);

    expect(tick.placedEntry).toBe(false);
    expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
  });

  describe('kill switch', () => {
    /** Fills at bar 5, stops out at bar 6 for a ~-5% loss. */
    async function tradeThroughALoss(
      killSwitch: KillSwitch,
      journal?: MemoryJournal,
    ): Promise<{ adapter: PaperAdapter; engine: LiveEngine; strategy: OneShotStrategy }> {
      const rows = flatBars(12);
      rows[5] = [100, 97.5]; // fills the 98 entry
      rows[6] = [99, 94]; // takes out the 95 stop
      const data = new ScriptedData({ '15m': series(rows) });
      const strategy = new OneShotStrategy(bar(4));
      const adapter = new PaperAdapter();
      const engine = new LiveEngine(data, strategy, adapter, {
        symbol: SYMBOL,
        timeframes: ['15m'],
        baseTimeframe: '15m',
        window: 100,
        killSwitch,
        journal,
      });

      await engine.warmup(bar(4) + 1_000);
      await engine.tick(bar(4) + M15 + 1_000); // entry placed
      await engine.tick(bar(5) + M15 + 1_000); // filled
      return { adapter, engine, strategy };
    }

    it('halts once the daily loss limit is breached', async () => {
      const killSwitch = new KillSwitch({ maxDailyDrawdown: 0.03 });
      const { engine } = await tradeThroughALoss(killSwitch);

      const tick = await engine.tick(bar(6) + M15 + 1_000); // stop-out

      expect(tick.halted).toMatch(/daily loss/);
      expect(killSwitch.isHalted).toBe(true);
    });

    it('stops asking the strategy for entries once halted', async () => {
      const killSwitch = new KillSwitch({ maxDailyDrawdown: 0.03 });
      const { engine, strategy } = await tradeThroughALoss(killSwitch);
      await engine.tick(bar(6) + M15 + 1_000);

      const callsAtHalt = strategy.seenLastBars.length;
      await engine.tick(bar(7) + M15 + 1_000);
      await engine.tick(bar(8) + M15 + 1_000);

      expect(strategy.seenLastBars.length).toBe(callsAtHalt);
    });

    it('cancels a resting entry when it trips', async () => {
      const killSwitch = new KillSwitch({ maxDailyDrawdown: 0.03 });
      const rows = flatBars(12);
      rows[5] = [100, 97.5];
      rows[6] = [99, 94];
      const data = new ScriptedData({ '15m': series(rows) });
      // Fires on every bar, so a fresh entry rests when the loss lands.
      const strategy = new AlwaysSignalStrategy();
      const adapter = new PaperAdapter();
      const engine = new LiveEngine(data, strategy, adapter, {
        symbol: SYMBOL,
        timeframes: ['15m'],
        baseTimeframe: '15m',
        window: 100,
        killSwitch,
      });

      await engine.warmup(bar(4) + 1_000);
      await engine.tick(bar(4) + M15 + 1_000);
      await engine.tick(bar(5) + M15 + 1_000);
      await engine.tick(bar(6) + M15 + 1_000); // loss lands, switch trips

      expect(killSwitch.isHalted).toBe(true);
      expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
    });

    it('records the halt so a restart stays halted', async () => {
      const journal = new MemoryJournal();
      const killSwitch = new KillSwitch({ maxDailyDrawdown: 0.03 });
      const { engine } = await tradeThroughALoss(killSwitch, journal);
      await engine.tick(bar(6) + M15 + 1_000);

      expect(journal.events.some((event) => event.type === 'halted')).toBe(true);

      // A fresh process, reading the same journal.
      const restarted = new KillSwitch({ maxDailyDrawdown: 0.03 });
      new LiveEngine(
        new ScriptedData({ '15m': series(flatBars(12)) }),
        new OneShotStrategy(bar(99)),
        new PaperAdapter(),
        {
          symbol: SYMBOL,
          timeframes: ['15m'],
          baseTimeframe: '15m',
          killSwitch: restarted,
          journal,
        },
      );

      expect(restarted.isHalted).toBe(true);
      expect(restarted.reason).toMatch(/daily loss/);
    });

    it('a recorded resume clears the halt on restart', async () => {
      const journal = new MemoryJournal();
      journal.append({ type: 'halted', at: bar(1), reason: 'manual' });
      journal.append({ type: 'resumed', at: bar(2), note: 'operator' });

      const killSwitch = new KillSwitch({ maxDailyDrawdown: 0.03 });
      new LiveEngine(
        new ScriptedData({ '15m': series(flatBars(6)) }),
        new OneShotStrategy(bar(99)),
        new PaperAdapter(),
        { symbol: SYMBOL, timeframes: ['15m'], baseTimeframe: '15m', killSwitch, journal },
      );

      expect(killSwitch.isHalted).toBe(false);
    });
  });

  it('rejects an unknown timeframe up front', () => {
    expect(
      () =>
        new LiveEngine(new ScriptedData({}), new OneShotStrategy(bar(0)), new PaperAdapter(), {
          symbol: SYMBOL,
          timeframes: ['13m'],
          baseTimeframe: '13m',
        }),
    ).toThrow(/Unknown timeframe/);
  });
});
