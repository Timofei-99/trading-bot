import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { JournalEvent, TradeJournalPort } from '../domain/order';
import { entryOrderId } from '../domain/order-id';
import { CandleRequest, MarketDataPort, Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import { PaperAdapter } from '../execution/paper.adapter';
import { LiveEngine } from './live.engine';

const SYMBOL = 'BTC/USDT';
const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number): number => T0 + i * M15;
/** A moment inside bar `i`, i.e. after it closed but before the next one does. */
const during = (i: number): number => bar(i) + M15 + 1;

/**
 * A crash is a process that stops between two statements and comes back with
 * nothing but its journal. These tests are that, exactly: a `LiveEngine` is
 * built, driven to a point, thrown away, and a second one is built over the
 * SAME journal — which is all a restart really is.
 *
 * The property under test throughout: settlement is replayed, entry decisions
 * are not, and nothing is placed twice.
 */

class MemoryJournal implements TradeJournalPort {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  readAll(): JournalEvent[] {
    return [...this.events];
  }
  /** Everything written up to a point — the journal a crash would leave. */
  truncatedTo(count: number): MemoryJournal {
    const copy = new MemoryJournal();
    copy.events.push(...this.events.slice(0, count));
    return copy;
  }
  countOf(type: JournalEvent['type']): number {
    return this.events.filter((event) => event.type === type).length;
  }
}

class ScriptedData implements MarketDataPort {
  constructor(private readonly series: CandleSeries) {}
  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    return this.series.between(request.startMs, request.endMs);
  }
}

/** Fires a long at one nominated bar, once. */
class OneShot extends Strategy {
  readonly name = 'one-shot';
  readonly version = '1.0';

  constructor(private readonly triggerTime: number) {
    super();
  }

  checkEntry(context: MarketContext): Signal | null {
    const series = context.candles('15m');
    if (series.isEmpty || series.lastTime !== this.triggerTime) {
      return null;
    }
    return new Signal({
      symbol: SYMBOL,
      direction: Direction.Long,
      entry: 98,
      stopLoss: 95,
      takeProfit: 102,
      timeframe: '15m',
      timestamp: series.lastTime,
      strategyName: this.name,
      strategyVersion: this.version,
    });
  }
}

/** rows[i] = [high, low]; open and close sit mid-range. */
function series(rows: [number, number][]): CandleSeries {
  return CandleSeries.fromBars(
    rows.map(([high, low], i) => {
      const mid = (high + low) / 2;
      return [bar(i), mid, high, low, mid, 1000] as BarTuple;
    }),
  );
}

/**
 *  bar 0,1  quiet
 *  bar 2    low 97 — fills the resting entry at 98
 *  bar 3    high 103 — touches the take-profit at 102
 *  bar 4    quiet again: nothing here would settle the position
 *
 * Bar 4 is the point. If a restart only ever settles the newest bar, the
 * take-profit that traded on bar 3 is lost and the position stays open.
 */
const SCRIPT: [number, number][] = [
  [101, 99],
  [101, 99],
  [101, 97],
  [103, 99],
  [100, 99],
];

function engineOn(journal: MemoryJournal, triggerBar = bar(1)) {
  const adapter = PaperAdapter.restore({ initialBalance: 10_000, journal });
  const engine = new LiveEngine(
    new ScriptedData(series(SCRIPT)),
    new OneShot(triggerBar),
    adapter,
    {
      symbol: SYMBOL,
      timeframes: ['15m'],
      baseTimeframe: '15m',
      window: 50,
      journal,
    },
  );
  return { adapter, engine };
}

describe('restart', () => {
  describe('settlement missed during an outage', () => {
    it('settles a bar that closed while the process was down', async () => {
      // Run to bar 2: the entry rests on bar 1 and fills on bar 2.
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));
      await first.engine.tick(during(2));
      expect(await first.adapter.getPosition(SYMBOL)).not.toBeNull();

      // Crash. Bars 3 and 4 close while nothing is running.
      const second = engineOn(journal);
      await second.engine.warmup(during(4));
      await second.engine.tick(during(4));

      // The take-profit traded on bar 3. Bar 4 never touches it, so the only
      // way this closes is by settling the bar that was missed.
      expect(await second.adapter.getPosition(SYMBOL)).toBeNull();
      const [closed] = await second.adapter.getClosedTrades();
      expect(closed.exitReason).toBe('tp');
      expect(closed.exitTime).toBe(bar(3));
    });

    it('reports the caught-up close in the tick result', async () => {
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));
      await first.engine.tick(during(2));

      const second = engineOn(journal);
      await second.engine.warmup(during(4));
      const result = await second.engine.tick(during(4));

      expect(result.closedTrades).toBe(1);
      expect(result.processedBar).toBe(bar(4));
    });
  });

  describe('a first start, with no journal to restore', () => {
    it('does not act on bars that closed before the process existed', async () => {
      const journal = new MemoryJournal();
      const { adapter, engine } = engineOn(journal, bar(1));

      await engine.warmup(during(4));
      const result = await engine.tick(during(4));

      // Bar 4 is the newest; bars 0-3 predate this process and are not its
      // business, so nothing is settled and no entry is placed.
      expect(result.processedBar).toBeNull();
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
      expect(journal.countOf('entry_placed')).toBe(0);
    });
  });

  describe('bar_processed', () => {
    it('is written once per completed bar', async () => {
      const journal = new MemoryJournal();
      const { engine } = engineOn(journal);

      await engine.warmup(during(0));
      await engine.tick(during(1));
      await engine.tick(during(2));

      expect(journal.countOf('bar_processed')).toBe(2);
    });

    it('is not written when the tick had no new bar to act on', async () => {
      const journal = new MemoryJournal();
      const { engine } = engineOn(journal);

      await engine.warmup(during(0));
      await engine.tick(during(1));
      const before = journal.countOf('bar_processed');
      await engine.tick(during(1));

      expect(journal.countOf('bar_processed')).toBe(before);
    });

    it('is the last event of the tick, so a crash before it leaves the bar unfinished', async () => {
      const journal = new MemoryJournal();
      const { engine } = engineOn(journal);

      await engine.warmup(during(0));
      await engine.tick(during(1));

      const last = journal.events[journal.events.length - 1];
      expect(last.type).toBe('bar_processed');
    });

    it('makes a restart resume from the recorded bar, not the newest one', async () => {
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));

      const second = engineOn(journal);
      await second.engine.warmup(during(2));

      expect(second.engine.lastCompletedBar).toBe(bar(1));
    });
  });

  describe('a crash between placing an entry and finishing the bar', () => {
    it('does not place the entry a second time', async () => {
      // Drive one tick, then throw away everything after the entry was
      // recorded — the journal a crash mid-tick would leave behind.
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));

      const placedAt = journal.events.findIndex((event) => event.type === 'entry_placed');
      expect(placedAt).toBeGreaterThanOrEqual(0);
      const crashed = journal.truncatedTo(placedAt + 1);
      expect(crashed.countOf('bar_processed')).toBe(0);

      // The restart therefore re-runs bar 1 — and must not open a second order.
      const second = engineOn(crashed);
      await second.engine.warmup(during(1));
      await second.engine.tick(during(1));

      expect(crashed.countOf('entry_placed')).toBe(1);
      expect(await second.adapter.getRestingEntry(SYMBOL)).not.toBeNull();
    });

    it('carries the same idempotency key when the same signal is recomputed', async () => {
      // The last line of defence, and the only one that works when the crash
      // happened after the VENUE accepted the order but before we wrote
      // anything down: recomputing the decision recomputes the key, and the
      // venue rejects the duplicate.
      const journal = new MemoryJournal();
      const { engine } = engineOn(journal);
      await engine.warmup(during(0));
      await engine.tick(during(1));

      const placed = journal.events.find((event) => event.type === 'entry_placed');
      const recomputed = new OneShot(bar(1)).checkEntry(contextAt(bar(1))) as Signal;

      expect(placed).toBeDefined();
      expect(entryOrderId(recomputed)).toBe(
        (placed as Extract<JournalEvent, { type: 'entry_placed' }>).orderId,
      );
    });
  });

  describe('restored state', () => {
    it('keeps the resting entry across a restart', async () => {
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));

      const second = engineOn(journal);
      const resting = await second.adapter.getRestingEntry(SYMBOL);

      expect(resting).not.toBeNull();
      expect(resting?.signal.entry).toBe(98);
    });

    it('keeps the balance across a restart', async () => {
      const journal = new MemoryJournal();
      const first = engineOn(journal);
      await first.engine.warmup(during(0));
      await first.engine.tick(during(1));
      await first.engine.tick(during(2));
      await first.engine.tick(during(3));
      const balanceBefore = await first.adapter.getBalance();

      const second = engineOn(journal);

      expect(await second.adapter.getBalance()).toBe(balanceBefore);
    });

    it('converges on the same closed trades whether or not it crashed', async () => {
      // The end state must not depend on how many times the process died.
      const straight = new MemoryJournal();
      const uninterrupted = engineOn(straight);
      await uninterrupted.engine.warmup(during(0));
      for (const i of [1, 2, 3, 4]) {
        await uninterrupted.engine.tick(during(i));
      }

      const interrupted = new MemoryJournal();
      const a = engineOn(interrupted);
      await a.engine.warmup(during(0));
      await a.engine.tick(during(1));
      await a.engine.tick(during(2));
      const b = engineOn(interrupted); // crash and restart
      await b.engine.warmup(during(4));
      await b.engine.tick(during(4));

      const expected = await uninterrupted.adapter.getClosedTrades();
      const actual = await b.adapter.getClosedTrades();

      expect(actual).toHaveLength(expected.length);
      expect(actual[0].exitPrice).toBe(expected[0].exitPrice);
      expect(actual[0].exitReason).toBe(expected[0].exitReason);
      expect(await b.adapter.getBalance()).toBe(await uninterrupted.adapter.getBalance());
    });
  });
});

/** A context ending on `time`, as the engine would build it. */
function contextAt(time: number): MarketContext {
  const context = new MarketContext(SYMBOL, ['15m'], 50);
  context.load('15m', series(SCRIPT).visibleAt(time));
  return context;
}
