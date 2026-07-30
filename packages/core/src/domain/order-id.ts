import { Signal } from './signal';

/**
 * The idempotency key an entry order carries to the venue.
 *
 * Derived from the signal, never random. That is the whole point: if the
 * process dies after the venue accepted an order but before we recorded it,
 * the restart recomputes the SAME id for the same signal, and the venue
 * rejects the second placement as a duplicate. A random id would produce a
 * second, real, unwanted position instead.
 *
 * The inputs are exactly what makes a signal the one it is:
 *
 *  - `strategyName` and `strategyVersion` — two strategies may legitimately
 *    want the same symbol on the same bar, and a retuned strategy is a
 *    different opinion, not the same one.
 *  - `symbol`
 *  - `timestamp` — the close of the signal bar. A strategy emits at most one
 *    entry per bar, so this is what makes the key unique in time.
 *  - `direction` — a strategy that flips within a bar is emitting a different
 *    order, not a retry of the same one.
 *
 * Deliberately NOT included: entry, stop and target prices. If a restart
 * recomputes a signal with a slightly different level — a rounding difference,
 * a detector reading one more bar of history — that is still the same trading
 * decision, and it must collide rather than open a second position.
 */
export function entryOrderId(signal: Signal): string {
  const parts = [
    signal.strategyName,
    signal.strategyVersion,
    signal.symbol,
    signal.direction,
    String(signal.timestamp),
  ];
  return `bot-${fingerprint(parts.join('|'))}`;
}

/**
 * The idempotency key for the market order that CLOSES a position.
 *
 * Same reasoning as the entry, and the stakes are higher: a lost reply to a
 * market sell, retried with a fresh id after a restart, sells a position that
 * is no longer there. Derived from the entry's id, which is already unique per
 * strategy, symbol and bar, so one position can only ever be closed once.
 */
export function exitOrderId(entryId: string): string {
  return `${entryId}-x`;
}

/**
 * FNV-1a, 32-bit, rendered as 8 hex characters.
 *
 * A hash rather than the raw fields because venues bound the length of a
 * client order id and reject characters that appear in symbols (Bybit's
 * `orderLinkId` is capped at 36 and `BTC/USDT` contains a slash). FNV-1a is
 * not cryptographic and does not need to be — the id is a collision-avoidance
 * key within one account, not a secret, and nothing trusts it for
 * authentication.
 */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime (16777619) by shifts, keeping the result in uint32.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Prefix every id this bot generates carries. */
export const ORDER_ID_PREFIX = 'bot-';

/** Compiled once: this runs per order in a list fetched from the venue. */
const BOT_ORDER_ID = new RegExp(`^${ORDER_ID_PREFIX}[0-9a-f]{8}(-x)?$`);

/**
 * Whether an id at the venue looks like one this bot produced.
 *
 * Used by startup reconciliation to tell "an order we placed and failed to
 * record" from "an order somebody placed by hand". The two need opposite
 * treatment, and the venue reports both the same way.
 *
 * Deliberately a shape check rather than a recomputation: an order we lost
 * track of is exactly the one whose signal we can no longer reproduce.
 */
export function isBotOrderId(clientOrderId: string | null): boolean {
  return clientOrderId !== null && BOT_ORDER_ID.test(clientOrderId);
}
