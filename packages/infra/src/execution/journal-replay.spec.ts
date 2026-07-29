import { JournalEvent, serializeSignal } from '@bot/core/domain/order';
import { Direction, Signal } from '@bot/core/domain/signal';

import { replayJournal } from './journal-replay';

const T = Date.UTC(2024, 0, 15, 9);

const signal = (over: Partial<ConstructorParameters<typeof Signal>[0]> = {}) =>
  new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry: 42_000,
    stopLoss: 41_000,
    takeProfit: 44_000,
    timeframe: '15m',
    timestamp: T,
    strategyName: 'test',
    strategyVersion: '1.0',
    ...over,
  });

const placed = (orderId = 'bot-1'): JournalEvent => ({
  type: 'entry_placed',
  at: T,
  orderId,
  positionSize: 0.5,
  signal: serializeSignal(signal()),
});

const acknowledged = (orderId = 'bot-1', exchangeOrderId = 'venue-1'): JournalEvent => ({
  type: 'entry_acknowledged',
  at: T,
  orderId,
  symbol: 'BTC/USDT',
  exchangeOrderId,
});

const filled = (orderId = 'bot-1'): JournalEvent => ({
  type: 'entry_settled',
  at: T,
  orderId,
  symbol: 'BTC/USDT',
  status: 'filled',
  fillPrice: 42_000,
  fillTime: T + 60_000,
});

const closedAt = (balance: number): JournalEvent => ({
  type: 'position_closed',
  at: T,
  orderId: 'bot-1',
  symbol: 'BTC/USDT',
  exitPrice: 44_000,
  exitTime: T + 120_000,
  exitReason: 'tp',
  pnlPct: 0.0476,
  balance,
});

const replay = (events: JournalEvent[]) => replayJournal(events, 0.001);

/**
 * What the process believes it owns after a crash.
 *
 * Every case below is a journal that a real outage can produce, including the
 * ones that stop halfway through an order's life — those are the whole reason
 * the events are separate in the first place.
 */
describe('replayJournal', () => {
  it('starts from nothing', () => {
    expect(replay([])).toEqual({ resting: null, position: null, closed: [], balance: 0 });
  });

  describe('an entry that never settled', () => {
    it('comes back as resting', () => {
      const state = replay([placed()]);

      expect(state.resting?.order.orderId).toBe('bot-1');
      expect(state.resting?.order.status).toBe('open');
      expect(state.position).toBeNull();
    });

    it('has no venue id until one was acknowledged', () => {
      // The gap between placed and acknowledged is exactly "we do not know if
      // it arrived", and reconciliation reads it that way.
      expect(replay([placed()]).resting?.exchangeOrderId).toBeNull();
    });

    it('picks up the venue id once it was', () => {
      expect(replay([placed(), acknowledged()]).resting?.exchangeOrderId).toBe('venue-1');
    });

    it('ignores an acknowledgement for a different order', () => {
      // A late ack for a superseded entry must not attach its venue id to the
      // one currently resting, or a cancel would target the wrong order.
      const state = replay([placed('bot-2'), acknowledged('bot-1', 'venue-1')]);

      expect(state.resting?.exchangeOrderId).toBeNull();
    });

    it('restores the signal well enough to act on', () => {
      const state = replay([placed()]);

      expect(state.resting?.order.signal.entry).toBe(42_000);
      expect(state.resting?.order.signal.stopLoss).toBe(41_000);
      expect(state.resting?.order.signal.direction).toBe(Direction.Long);
      expect(state.resting?.order.positionSize).toBe(0.5);
    });
  });

  describe('an entry that filled', () => {
    it('becomes an open position and stops resting', () => {
      const state = replay([placed(), acknowledged(), filled()]);

      expect(state.resting).toBeNull();
      expect(state.position?.orderId).toBe('bot-1');
      expect(state.position?.entryPrice).toBe(42_000);
      expect(state.position?.entryTime).toBe(T + 60_000);
    });

    it('carries the fee rate, so the restored position prices out the same', () => {
      // An open trade has no pnl yet, so the fee only shows once it closes —
      // which is exactly where getting it wrong would misreport the account.
      const round = [placed(), filled(), closedAt(10_500)];
      const withFee = replayJournal(round, 0.001);
      const withoutFee = replayJournal(round, 0);

      expect(withFee.closed[0].pnlPct).toBeLessThan(withoutFee.closed[0].pnlPct as number);
    });
  });

  describe('an entry that did not fill', () => {
    it.each(['cancelled', 'expired'] as const)('stops resting after %s', (status) => {
      const state = replay([
        placed(),
        { ...(filled() as Extract<JournalEvent, { type: 'entry_settled' }>), status },
      ]);

      expect(state.resting).toBeNull();
      expect(state.position).toBeNull();
    });
  });

  describe('a position that closed', () => {
    it('moves to the closed list with its exit recorded', () => {
      const state = replay([placed(), filled(), closedAt(10_500)]);

      expect(state.position).toBeNull();
      expect(state.closed).toHaveLength(1);
      expect(state.closed[0].exitPrice).toBe(44_000);
      expect(state.closed[0].exitReason).toBe('tp');
    });

    it('takes the balance the close reported', () => {
      // The journal's balance is the anchor; recomputing it from trades would
      // drift from what the venue actually did.
      expect(replay([placed(), filled(), closedAt(10_500)]).balance).toBe(10_500);
    });
  });

  describe('balance', () => {
    it('comes from a session event when there is one', () => {
      expect(replay([{ type: 'session', at: T, note: 'start', balance: 9_000 }]).balance).toBe(
        9_000,
      );
    });

    it('takes the last one written', () => {
      const state = replay([
        { type: 'session', at: T, note: 'start', balance: 9_000 },
        placed(),
        filled(),
        closedAt(10_500),
      ]);

      expect(state.balance).toBe(10_500);
    });
  });

  describe('events that are not the adapter’s business', () => {
    it('ignores the engine’s own bookkeeping', () => {
      // halted / resumed / bar_processed belong to LiveEngine's restore. The
      // adapter must pass over them rather than throw on an unknown type.
      const state = replay([
        { type: 'halted', at: T, reason: 'daily loss' },
        { type: 'bar_processed', at: T, symbol: 'BTC/USDT', barTime: T },
        placed(),
        { type: 'resumed', at: T, note: 'manual' },
      ]);

      expect(state.resting?.order.orderId).toBe('bot-1');
    });
  });

  describe('journals that stop mid-sequence', () => {
    it('survives a settle with nothing resting', () => {
      expect(() => replay([filled()])).not.toThrow();
      expect(replay([filled()]).position).toBeNull();
    });

    it('survives a close with nothing open', () => {
      expect(() => replay([closedAt(10_000)])).not.toThrow();
      expect(replay([closedAt(10_000)]).closed).toEqual([]);
    });

    it('survives an acknowledgement with nothing resting', () => {
      expect(() => replay([acknowledged()])).not.toThrow();
    });
  });

  it('replays a full round trip into a clean slate', () => {
    const state = replay([
      { type: 'session', at: T, note: 'start', balance: 10_000 },
      placed(),
      acknowledged(),
      filled(),
      closedAt(10_500),
    ]);

    expect(state).toMatchObject({ resting: null, position: null, balance: 10_500 });
    expect(state.closed).toHaveLength(1);
  });

  it('is a pure fold — replaying twice gives the same answer', () => {
    const events = [placed(), acknowledged(), filled(), closedAt(10_500)];

    expect(replay(events)).toEqual(replay(events));
  });
});
