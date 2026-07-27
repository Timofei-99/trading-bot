import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
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
