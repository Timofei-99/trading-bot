import { JournalEvent, serializeSignal, TradeJournalPort } from '@bot/core/domain/order';
import { entryOrderId, exitOrderId } from '@bot/core/domain/order-id';
import { Direction, Signal } from '@bot/core/domain/signal';

import { BybitAdapter } from './bybit.adapter';
import {
  ExchangeClient,
  ExchangeOrder,
  MarketSpec,
  PlaceLimitOrderRequest,
} from './exchange-client';

const SYMBOL = 'BTC/USDT';
const T0 = Date.UTC(2024, 0, 1);

const signal = (): Signal =>
  new Signal({
    symbol: SYMBOL,
    direction: Direction.Long,
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    timeframe: '15m',
    timestamp: T0,
    strategyName: 'test',
    strategyVersion: '1',
  });

const OURS = entryOrderId(signal());

function order(over: Partial<ExchangeOrder> = {}): ExchangeOrder {
  return {
    id: 'venue-1',
    clientOrderId: OURS,
    symbol: SYMBOL,
    side: 'buy',
    price: 100,
    amount: 0.5,
    filled: 0,
    average: null,
    status: 'open',
    timestamp: T0,
    feeCost: null,
    ...over,
  };
}

class MemoryJournal implements TradeJournalPort {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  readAll(): JournalEvent[] {
    return [...this.events];
  }
}

/** Only what reconciliation touches; everything else throws if reached. */
class Venue implements ExchangeClient {
  openOrders: ExchangeOrder[] = [];
  readonly fetched: string[] = [];
  readonly cancelled: string[] = [];

  async loadMarket(): Promise<MarketSpec> {
    return { priceTick: 0.01, amountStep: 0.001, minAmount: null, minNotional: null };
  }
  priceToPrecision(_symbol: string, price: number): number {
    return price;
  }
  amountToPrecision(_symbol: string, amount: number): number {
    return amount;
  }
  async placeLimitOrder(_request: PlaceLimitOrderRequest): Promise<ExchangeOrder> {
    throw new Error('placeLimitOrder must not be reached during reconciliation');
  }
  async placeMarketOrder(): Promise<ExchangeOrder> {
    throw new Error('placeMarketOrder must not be reached during reconciliation');
  }
  async cancelOrder(_symbol: string, id: string): Promise<void> {
    this.cancelled.push(id);
  }
  async fetchOrder(_symbol: string, id: string): Promise<ExchangeOrder> {
    this.fetched.push(id);
    const found = this.openOrders.find((candidate) => candidate.id === id);
    return found ?? order({ id, status: 'canceled' });
  }
  async fetchOpenOrders(): Promise<ExchangeOrder[]> {
    return [...this.openOrders];
  }
  async fetchFreeBalance(): Promise<number> {
    return 10_000;
  }
  async fetchServerTime(): Promise<number> {
    return T0;
  }
}

function adapter(venue: Venue, journal?: TradeJournalPort) {
  const lines: string[] = [];
  const subject = new BybitAdapter(venue, {
    symbol: SYMBOL,
    journal,
    sleep: async () => undefined,
    retryBaseMs: 0,
    log: (line) => lines.push(line),
  });
  return { subject, lines, text: () => lines.join('\n') };
}

/**
 * Startup reconciliation against the venue's open orders.
 *
 * The case that matters is the one the old implementation could not see: it
 * returned early when the journal had no resting entry, so an order placed by
 * a run that died before recording it stayed at the venue forever — untracked,
 * never cancelled, and no obstacle to placing a second one beside it.
 */
describe('reconcile', () => {
  describe('an order of ours the journal cannot account for', () => {
    it('refuses to start', async () => {
      const venue = new Venue();
      venue.openOrders = [order()];

      await expect(adapter(venue, new MemoryJournal()).subject.start(T0)).rejects.toThrow(
        /Refusing to start/,
      );
    });

    it('refuses even with no journal at all', async () => {
      // Running without a journal is legal; it does not make an untracked
      // order at the venue any safer.
      const venue = new Venue();
      venue.openOrders = [order()];

      await expect(adapter(venue).subject.start(T0)).rejects.toThrow(/Refusing to start/);
    });

    it('names the order so it can be found and cancelled by hand', async () => {
      const venue = new Venue();
      venue.openOrders = [order({ id: 'venue-77' })];

      await expect(adapter(venue).subject.start(T0)).rejects.toThrow(
        new RegExp(`${OURS}.*venue-77`),
      );
    });

    it('says why it did not cancel anything itself', async () => {
      // The id encodes strategy, symbol, direction and bar — but not which RUN
      // placed it, so cancelling on that guess could spend another bot's money.
      const venue = new Venue();
      venue.openOrders = [order()];

      await expect(adapter(venue).subject.start(T0)).rejects.toThrow(
        /may belong to another bot on this account/,
      );
      expect(venue.cancelled).toEqual([]);
    });

    it('counts them all', async () => {
      const venue = new Venue();
      venue.openOrders = [order({ id: 'a' }), order({ id: 'b', clientOrderId: 'bot-12345678' })];

      await expect(adapter(venue).subject.start(T0)).rejects.toThrow(/holds 2 order\(s\)/);
    });

    it('catches an exit order as readily as an entry', async () => {
      const venue = new Venue();
      venue.openOrders = [order({ clientOrderId: exitOrderId('bot-deadbeef') })];

      await expect(adapter(venue).subject.start(T0)).rejects.toThrow(/Refusing to start/);
    });
  });

  describe('an order that is not ours', () => {
    it('starts anyway and leaves it alone', async () => {
      // Cancelling a hand-placed order because it was in the way would be a
      // far worse bug than the one this guard exists for.
      const venue = new Venue();
      venue.openOrders = [order({ clientOrderId: 'placed-by-hand' })];

      const subject = adapter(venue);
      await subject.subject.start(T0);

      expect(venue.cancelled).toEqual([]);
      expect(subject.text()).toContain('not this bot');
    });

    it('says nothing when the venue is empty', async () => {
      const subject = adapter(new Venue());

      await subject.subject.start(T0);

      expect(subject.text()).not.toContain('not this bot');
    });

    it('treats an order with no client id as somebody else’s', async () => {
      const venue = new Venue();
      venue.openOrders = [order({ clientOrderId: null })];

      await expect(adapter(venue).subject.start(T0)).resolves.toBeUndefined();
    });
  });

  describe('an order the journal does know about', () => {
    const journalWithResting = () => {
      const journal = new MemoryJournal();
      journal.append({
        type: 'entry_placed',
        at: T0,
        orderId: OURS,
        positionSize: 0.5,
        signal: serializeSignal(signal()),
      });
      return journal;
    };

    it('is not an orphan, and reconciles normally', async () => {
      const venue = new Venue();
      venue.openOrders = [order()];

      const subject = adapter(venue, journalWithResting());
      await subject.subject.start(T0);

      expect(subject.text()).toContain('still resting at the venue');
      expect(await subject.subject.getRestingEntry(SYMBOL)).not.toBeNull();
    });

    it('picks up the venue id it did not have', async () => {
      // The journal recorded the placement but never the acknowledgement, so
      // the venue id is learned here and a later cancel can target it.
      const venue = new Venue();
      venue.openOrders = [order({ id: 'venue-42' })];

      const subject = adapter(venue, journalWithResting());
      await subject.subject.start(T0);

      expect(subject.text()).toContain('still resting');
      expect(venue.fetched).toEqual([]);
    });

    it('drops an unacknowledged entry the venue never saw', async () => {
      const venue = new Venue();
      venue.openOrders = [];

      const journal = journalWithResting();
      const subject = adapter(venue, journal);
      await subject.subject.start(T0);

      expect(subject.text()).toContain('unknown to the venue, dropped');
      expect(await subject.subject.getRestingEntry(SYMBOL)).toBeNull();
      expect(journal.events.at(-1)).toMatchObject({ type: 'entry_settled', status: 'cancelled' });
    });

    it('adopts an entry that filled while the process was away', async () => {
      const journal = journalWithResting();
      journal.append({
        type: 'entry_acknowledged',
        at: T0,
        orderId: OURS,
        symbol: SYMBOL,
        exchangeOrderId: 'venue-1',
      });
      const venue = new Venue();
      // Gone from the open list, and the venue reports it closed and filled.
      venue.openOrders = [];

      const subject = adapter(venue, journal);
      await subject.subject.start(T0);

      expect(subject.text()).toContain('ended as canceled');
      expect(venue.fetched).toEqual(['venue-1']);
    });
  });

  it('does not consider an exit id an orphan while its position is open', async () => {
    // A live position's exit legs carry `<entry>-x` and legitimately rest at
    // the venue; treating them as orphans would make every restart refuse.
    const journal = new MemoryJournal();
    journal.append({
      type: 'entry_placed',
      at: T0,
      orderId: OURS,
      positionSize: 0.5,
      signal: serializeSignal(signal()),
    });
    journal.append({
      type: 'entry_settled',
      at: T0,
      orderId: OURS,
      symbol: SYMBOL,
      status: 'filled',
      fillPrice: 100,
      fillTime: T0,
    });
    const venue = new Venue();
    venue.openOrders = [order({ id: 'venue-exit', clientOrderId: exitOrderId(OURS) })];

    const subject = adapter(venue, journal);

    await expect(subject.subject.start(T0)).resolves.toBeUndefined();
    expect(await subject.subject.getPosition(SYMBOL)).not.toBeNull();
  });
});
