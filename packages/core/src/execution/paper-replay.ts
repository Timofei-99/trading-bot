import { deserializeSignal, EntryOrder, JournalEvent } from '../domain/order';
import { ExitReason, Trade } from '../domain/trade';

export interface RestoredPaperState {
  /** Resting entries by symbol. */
  readonly restingEntries: Map<string, EntryOrder>;
  readonly openPositions: Map<string, Trade>;
  readonly closedTrades: Trade[];
  /** Balance as of the last event that reported one, or the opening balance. */
  readonly balance: number;
}

/**
 * Rebuild paper-trading state from the journal — a pure fold over the events.
 *
 * Pure for the same reason as the venue adapter's replay: this used to be a
 * method that mutated the adapter while a `replaying` flag suppressed writes
 * back to the journal. That arrangement works until someone adds a
 * state-changing method and does not know the flag exists, at which point
 * restoring an account silently appends a second copy of its own history.
 * Separated out, there is nothing to forget — the fold has nothing to write
 * to.
 *
 * Unlike the venue adapter this one is keyed by symbol throughout, because
 * paper trading is not restricted to a single market.
 */
export function replayPaperJournal(
  events: readonly JournalEvent[],
  openingBalance: number,
  feeRate: number,
): RestoredPaperState {
  const restingEntries = new Map<string, EntryOrder>();
  const openPositions = new Map<string, Trade>();
  const closedTrades: Trade[] = [];
  let balance = openingBalance;

  for (const event of events) {
    switch (event.type) {
      case 'session':
        balance = event.balance;
        break;

      case 'entry_placed':
        restingEntries.set(event.signal.symbol, {
          orderId: event.orderId,
          signal: deserializeSignal(event.signal),
          positionSize: event.positionSize,
          placedAt: event.at,
          status: 'open',
          fillPrice: null,
          fillTime: null,
        });
        break;

      case 'entry_settled': {
        const order = restingEntries.get(event.symbol);
        if (order === undefined) {
          break;
        }
        restingEntries.delete(event.symbol);
        order.status = event.status;
        if (event.status === 'filled') {
          order.fillPrice = event.fillPrice;
          order.fillTime = event.fillTime;
          openPositions.set(
            event.symbol,
            new Trade({
              signal: order.signal,
              orderId: order.orderId,
              entryTime: event.fillTime as number,
              entryPrice: event.fillPrice as number,
              positionSize: order.positionSize,
              feeRate,
            }),
          );
        }
        break;
      }

      case 'position_closed': {
        const trade = openPositions.get(event.symbol);
        if (trade === undefined) {
          break;
        }
        openPositions.delete(event.symbol);
        trade.exitPrice = event.exitPrice;
        trade.exitTime = event.exitTime;
        trade.exitReason = event.exitReason as ExitReason;
        closedTrades.push(trade);
        balance = event.balance;
        break;
      }

      // `entry_acknowledged` is venue bookkeeping and paper has no venue;
      // `halted`, `resumed` and `bar_processed` belong to the engine.
      default:
        break;
    }
  }

  return { restingEntries, openPositions, closedTrades, balance };
}
