import { JournalEvent, serializeSignal } from '../domain/order';
import { Direction, Signal } from '../domain/signal';
import { replayPaperJournal } from './paper-replay';

const T = Date.UTC(2024, 0, 15, 9);

const signal = (symbol = 'BTC/USDT') =>
  new Signal({
    symbol,
    direction: Direction.Long,
    entry: 42_000,
    stopLoss: 41_000,
    takeProfit: 44_000,
    timeframe: '15m',
    timestamp: T,
    strategyName: 'test',
    strategyVersion: '1.0',
  });

const placed = (symbol = 'BTC/USDT', orderId = 'bot-1'): JournalEvent => ({
  type: 'entry_placed',
  at: T,
  orderId,
  positionSize: 0.5,
  signal: serializeSignal(signal(symbol)),
});

const settled = (
  symbol = 'BTC/USDT',
  status: 'filled' | 'cancelled' | 'expired' = 'filled',
): JournalEvent => ({
  type: 'entry_settled',
  at: T,
  orderId: 'bot-1',
  symbol,
  status,
  fillPrice: status === 'filled' ? 42_000 : null,
  fillTime: status === 'filled' ? T + 60_000 : null,
});

const closed = (symbol = 'BTC/USDT', balance = 10_500): JournalEvent => ({
  type: 'position_closed',
  at: T,
  orderId: 'bot-1',
  symbol,
  exitPrice: 44_000,
  exitTime: T + 120_000,
  exitReason: 'tp',
  pnlPct: 0.0476,
  balance,
});

const replay = (events: JournalEvent[]) => replayPaperJournal(events, 10_000, 0);

describe('replayPaperJournal', () => {
  it('keeps the opening balance when the journal is empty', () => {
    // Unlike the venue adapter there is no account to ask afterwards, so the
    // opening balance has to survive an empty journal.
    expect(replay([]).balance).toBe(10_000);
  });

  it('restores a resting entry under its symbol', () => {
    const state = replay([placed()]);

    expect(state.restingEntries.get('BTC/USDT')?.orderId).toBe('bot-1');
    expect(state.openPositions.size).toBe(0);
  });

  it('tracks several symbols at once', () => {
    // Paper trading is not limited to one market, which is the whole reason
    // this fold is keyed by symbol.
    const state = replay([placed('BTC/USDT', 'bot-1'), placed('ETH/USDT', 'bot-2')]);

    expect([...state.restingEntries.keys()].sort()).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('turns a filled entry into an open position', () => {
    const state = replay([placed(), settled()]);

    expect(state.restingEntries.size).toBe(0);
    expect(state.openPositions.get('BTC/USDT')?.entryPrice).toBe(42_000);
  });

  it.each(['cancelled', 'expired'] as const)('drops a %s entry without opening one', (status) => {
    const state = replay([placed(), settled('BTC/USDT', status)]);

    expect(state.restingEntries.size).toBe(0);
    expect(state.openPositions.size).toBe(0);
  });

  it('books a closed position and takes its balance', () => {
    const state = replay([placed(), settled(), closed()]);

    expect(state.openPositions.size).toBe(0);
    expect(state.closedTrades).toHaveLength(1);
    expect(state.closedTrades[0].exitReason).toBe('tp');
    expect(state.balance).toBe(10_500);
  });

  it('closes only the symbol the event names', () => {
    const state = replay([
      placed('BTC/USDT', 'bot-1'),
      settled('BTC/USDT'),
      placed('ETH/USDT', 'bot-2'),
      settled('ETH/USDT'),
      closed('BTC/USDT'),
    ]);

    expect([...state.openPositions.keys()]).toEqual(['ETH/USDT']);
    expect(state.closedTrades).toHaveLength(1);
  });

  it('takes a session balance', () => {
    expect(replay([{ type: 'session', at: T, note: 'start', balance: 9_000 }]).balance).toBe(9_000);
  });

  describe('journals that stop mid-sequence', () => {
    it('survives a settle for a symbol with nothing resting', () => {
      expect(replay([settled()]).openPositions.size).toBe(0);
    });

    it('survives a close for a symbol with nothing open', () => {
      const state = replay([closed()]);

      expect(state.closedTrades).toEqual([]);
      // The balance is NOT taken from an event that closed nothing.
      expect(state.balance).toBe(10_000);
    });
  });

  it('ignores events that belong to the venue adapter or the engine', () => {
    const state = replay([
      {
        type: 'entry_acknowledged',
        at: T,
        orderId: 'bot-1',
        symbol: 'BTC/USDT',
        exchangeOrderId: 'v1',
      },
      { type: 'bar_processed', at: T, symbol: 'BTC/USDT', barTime: T },
      placed(),
    ]);

    expect(state.restingEntries.size).toBe(1);
  });

  it('applies the fee rate to what it restores', () => {
    const round = [placed(), settled(), closed()];

    const withFee = replayPaperJournal(round, 10_000, 0.001);
    const withoutFee = replayPaperJournal(round, 10_000, 0);

    expect(withFee.closedTrades[0].pnlPct).toBeLessThan(
      withoutFee.closedTrades[0].pnlPct as number,
    );
  });

  it('is a pure fold — replaying twice gives the same answer', () => {
    const events = [placed(), settled(), closed()];

    expect(replay(events)).toEqual(replay(events));
  });
});
