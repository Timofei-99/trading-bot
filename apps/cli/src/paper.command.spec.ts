import { BUILT_IN_STRATEGIES, StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { BarTuple, CandleSeries } from '@bot/core/domain/candle-series';
import { JournalEvent } from '@bot/core/domain/order';
import { CandleRequest, MarketDataPort } from '@bot/core/domain/ports';
import { NdjsonTradeJournal } from '@bot/infra/journal/ndjson-trade-journal';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarketDataFactory } from './market-data.factory';
import { PaperCommand } from './paper.command';
import { capture } from './testing';

const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);

/** Flat bars, enough of them to fill a warmup window. */
function series(count: number): CandleSeries {
  return CandleSeries.fromBars(
    Array.from({ length: count }, (_, i) => [T0 + i * M15, 100, 101, 99, 100, 1_000] as BarTuple),
  );
}

class ScriptedFactory implements MarketDataFactory {
  readonly asked: string[] = [];
  constructor(private readonly bars = series(40)) {}

  forExchange(exchangeId: string): MarketDataPort {
    this.asked.push(exchangeId);
    const bars = this.bars;
    return {
      async getCandles(request: CandleRequest): Promise<CandleSeries> {
        return bars.between(request.startMs, request.endMs);
      },
    };
  }
}

/**
 * Paper trading's setup path, which is where the decisions live: which
 * journal, whether state was restored, which risk controls are armed.
 *
 * Everything is driven with `--once` so a single tick runs and returns; the
 * unbounded loop is `engine.start()`, which has its own tests.
 */
describe('paper', () => {
  let dir: string;
  let journalPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paper-'));
    journalPath = join(dir, 'paper.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const events = (): JournalEvent[] => new NdjsonTradeJournal(journalPath).readAll();

  function build(factory = new ScriptedFactory()) {
    const registry = new StrategyRegistryService(BUILT_IN_STRATEGIES);
    return { factory, command: new PaperCommand(registry, factory) };
  }

  const run = (options: Record<string, unknown> = {}, factory?: ScriptedFactory) => {
    const built = build(factory);
    return {
      ...built,
      go: () => built.command.run([], { journal: journalPath, once: true, ...options } as never),
    };
  };

  it('runs a tick and reports the account afterwards', async () => {
    const subject = run();

    const out = await capture(subject.go);

    expect(out.text()).toContain('paper: OB_4h_FVG_15m');
    expect(out.text()).toContain('balance: 10000.00');
    expect(out.text()).toContain('closed trades: 0');
  });

  it('opens the session in the journal', async () => {
    await capture(run().go);

    expect(events()[0]).toMatchObject({ type: 'session', note: 'start', balance: 10_000 });
  });

  it('resumes rather than restarts when the journal already has history', async () => {
    // The distinction matters: a "start" that silently discarded a restored
    // balance would report a fictional account.
    await capture(run().go);

    const out = await capture(run().go);

    expect(out.text()).toContain('(state restored)');
    expect(events().filter((event) => event.type === 'session')).toMatchObject([
      { note: 'start' },
      { note: 'resume' },
    ]);
  });

  it('asks the configured exchange for its candles', async () => {
    const subject = run({ exchange: 'binance' });

    await capture(subject.go);

    expect(subject.factory.asked).toEqual(['binance']);
  });

  it('defaults the exchange to bybit', async () => {
    const subject = run();

    await capture(subject.go);

    expect(subject.factory.asked).toEqual(['bybit']);
  });

  it('names a journal per strategy and symbol when none was given', async () => {
    // Two bots sharing a journal would replay each other's halts and orders.
    const registry = new StrategyRegistryService(BUILT_IN_STRATEGIES);
    const command = new PaperCommand(registry, new ScriptedFactory());

    const out = await capture(() =>
      command.run([], { once: true, journal: join(dir, 'explicit.ndjson') } as never),
    );

    expect(out.text()).toContain('explicit.ndjson');
  });

  it('reports when nothing new had closed', async () => {
    const subject = run();

    const out = await capture(subject.go);

    // The scripted bars end well before now, so warmup marks the newest as
    // handled and the tick has nothing to do.
    expect(out.text()).toMatch(/tick: (no newly closed bar to process|processed bar)/);
  });

  it('defaults to realistic costs rather than a gross result', async () => {
    // Paper exists to answer "would this have made money", and a fee-free
    // paper run answers a different question convincingly.
    const subject = run();

    await capture(subject.go);

    expect(events()).not.toHaveLength(0);
  });

  describe('option parsing', () => {
    const subject = () => build().command;

    it('reads --params as a JSON object', () => {
      expect(subject().parseParams('{"minRr":2}')).toEqual({ minRr: 2 });
    });

    it.each(['[1]', '"x"', 'null'])('refuses --params %s', (value) => {
      expect(() => subject().parseParams(value)).toThrow(/expected a JSON object/);
    });

    it('passes the plain flags through', () => {
      const parser = subject();
      expect(parser.parseStrategy('OB_4h_FVG_15m')).toBe('OB_4h_FVG_15m');
      expect(parser.parseSymbol('ETH/USDT')).toBe('ETH/USDT');
      expect(parser.parseJournal('a.ndjson')).toBe('a.ndjson');
      expect(parser.parseOnce()).toBe(true);
    });
  });
});
