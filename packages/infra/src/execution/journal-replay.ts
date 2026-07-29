import { deserializeSignal, EntryOrder, JournalEvent } from '@bot/core/domain/order';
import { ExitReason, Trade } from '@bot/core/domain/trade';

export interface OpenState {
  readonly order: EntryOrder;
  /** Venue order id of the resting entry, once known. */
  exchangeOrderId: string | null;
}

export interface RestoredState {
  /** The entry still resting at the venue, if the journal ended with one. */
  readonly resting: OpenState | null;
  readonly position: Trade | null;
  readonly closed: Trade[];
  /** Balance as of the last event that reported one; 0 if none did. */
  readonly balance: number;
}

/**
 * Rebuild adapter state from the journal — a pure fold over the events.
 *
 * Pure on purpose. This used to be a method on `BybitAdapter` that mutated the
 * adapter's own fields while a `replaying` flag suppressed writes back to the
 * journal. That works, but it means every future state-changing method has to
 * remember the flag exists, and forgetting it corrupts the audit trail of a
 * live account. With the fold separated there is nothing to remember: replay
 * cannot write, because it has nothing to write to.
 *
 * Being pure also makes it testable without an exchange, which matters more
 * here than almost anywhere — this is the code that decides, after a crash,
 * whether the process believes it holds a position.
 */
export function replayJournal(events: readonly JournalEvent[], feeRate: number): RestoredState {
  let resting: OpenState | null = null;
  let position: Trade | null = null;
  let balance = 0;
  const closed: Trade[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'session':
        balance = event.balance;
        break;

      case 'entry_placed':
        resting = {
          order: {
            orderId: event.orderId,
            signal: deserializeSignal(event.signal),
            positionSize: event.positionSize,
            placedAt: event.at,
            status: 'open',
            fillPrice: null,
            fillTime: null,
          },
          exchangeOrderId: null,
        };
        break;

      case 'entry_acknowledged':
        // Only if it names the entry we are actually holding: an
        // acknowledgement for a superseded order must not attach a venue id to
        // the current one.
        if (resting !== null && resting.order.orderId === event.orderId) {
          resting.exchangeOrderId = event.exchangeOrderId;
        }
        break;

      case 'entry_settled': {
        if (resting === null) {
          break;
        }
        const settled = resting;
        resting = null;
        if (event.status === 'filled') {
          position = new Trade({
            signal: settled.order.signal,
            orderId: settled.order.orderId,
            entryTime: event.fillTime as number,
            entryPrice: event.fillPrice as number,
            positionSize: settled.order.positionSize,
            feeRate,
          });
        }
        break;
      }

      case 'position_closed': {
        if (position === null) {
          break;
        }
        const trade = position;
        position = null;
        trade.exitPrice = event.exitPrice;
        trade.exitTime = event.exitTime;
        trade.exitReason = event.exitReason as ExitReason;
        closed.push(trade);
        balance = event.balance;
        break;
      }

      // `halted`, `resumed` and `bar_processed` belong to the engine's own
      // restore; the adapter has no state that depends on them.
      default:
        break;
    }
  }

  return { resting, position, closed, balance };
}
