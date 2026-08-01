import { Direction } from '../domain/signal';

/** Bybit charges funding every 8 hours: 00:00, 08:00, 16:00 UTC. */
export const FUNDING_INTERVAL_MS = 8 * 3_600_000;

/**
 * How many funding timestamps fall in the half-open interval `(fromMs, toMs]`.
 *
 * Half-open on the left so that consecutive bars never double-charge the same
 * boundary: the bar that ends ON a funding timestamp pays it, and the next
 * bar starts counting strictly after.
 */
export function fundingEventsBetween(
  fromMs: number,
  toMs: number,
  intervalMs: number = FUNDING_INTERVAL_MS,
): number {
  if (toMs <= fromMs) {
    return 0;
  }
  return Math.floor(toMs / intervalMs) - Math.floor(fromMs / intervalMs);
}

/**
 * Quote-currency funding for holding a position through `events` fundings.
 *
 * Positive = the position pays. With a positive rate — the perpetual's normal
 * state — longs pay shorts, so a short's charge comes back negative: funding
 * is the one cost in this model that can be an income.
 *
 * The mark price is approximated by the price the caller has in hand (the
 * bar's close); the true mark at the funding instant is unknowable from OHLC
 * and the difference is far below the rate's own variance.
 */
export function fundingCharge(
  direction: Direction,
  positionSize: number,
  markPrice: number,
  ratePerInterval: number,
  events: number,
): number {
  const perEvent = positionSize * markPrice * ratePerInterval;
  return (direction === Direction.Long ? perEvent : -perEvent) * events;
}
