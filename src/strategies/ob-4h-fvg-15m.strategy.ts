import { FvgDetector } from '../detectors/fvg.detector';
import { LiquidityDetector } from '../detectors/liquidity.detector';
import { OrderBlockDetector } from '../detectors/order-block.detector';
import { PremiumDiscountDetector } from '../detectors/premium-discount.detector';
import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Pattern } from '../domain/pattern';
import { Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';

export interface Ob4hFvg15mOptions {
  readonly htf?: string;
  readonly ltf?: string;
  readonly swingLengthHtf?: number;
  readonly swingLengthLtf?: number;
  readonly obLookback?: number;
  readonly liquiditySweepLookback?: number;
  readonly minRr?: number;
}

/**
 * Bullish ICT entry: a 4h order block in discount, retested through a 15m FVG,
 * with a sell-side liquidity sweep for confirmation.
 *
 * All three conditions must hold on the current bar:
 *   1. An unmitigated bullish order block exists on the HTF whose midpoint is
 *      below the current dealing range's equilibrium (i.e. in discount).
 *   2. A bullish FVG on the LTF is being mitigated on THIS exact bar
 *      (`endTime === current bar`) and its zone overlaps the order block.
 *   3. Sell-side liquidity was swept on the LTF within the lookback window.
 *
 * Levels:
 *   entry      = fvg.high — the top of the gap, the first touch point
 *   stopLoss   = ob.low
 *   takeProfit = nearest unswept buy-side liquidity above entry, else
 *                entry + minRr * risk
 *
 * `entry` comes from a zone boundary established by earlier bars, never from
 * the triggering bar's own OHLC — that is what lets the engine fill on the
 * signal bar without look-ahead bias.
 */
export class Ob4hFvg15mStrategy extends Strategy {
  readonly name = 'OB_4h_FVG_15m';
  readonly version = '1.0';

  readonly htf: string;
  readonly ltf: string;
  readonly swingLengthHtf: number;
  readonly swingLengthLtf: number;
  readonly obLookback: number;
  readonly liquiditySweepLookback: number;
  readonly minRr: number;

  constructor(options: Ob4hFvg15mOptions = {}) {
    super();
    this.htf = options.htf ?? '4h';
    this.ltf = options.ltf ?? '15m';
    this.swingLengthHtf = options.swingLengthHtf ?? 3;
    this.swingLengthLtf = options.swingLengthLtf ?? 3;
    this.obLookback = options.obLookback ?? 5;
    this.liquiditySweepLookback = options.liquiditySweepLookback ?? 20;
    this.minRr = options.minRr ?? 2.0;
  }

  checkEntry(context: MarketContext): Signal | null {
    const htfCandles = context.candles(this.htf);
    const ltfCandles = context.candles(this.ltf);
    if (htfCandles.isEmpty || ltfCandles.isEmpty) {
      return null;
    }

    const orderBlock = this.selectOrderBlock(htfCandles);
    if (orderBlock === null) {
      return null;
    }

    const currentLtfTime = ltfCandles.lastTime as number;
    const fvg = this.selectFvg(ltfCandles, orderBlock, currentLtfTime);
    if (fvg === null) {
      return null;
    }

    const liquidity = new LiquidityDetector({
      swingLength: this.swingLengthLtf,
      timeframe: this.ltf,
    }).detect(ltfCandles);

    if (!this.sellSideRecentlySwept(ltfCandles, liquidity)) {
      return null;
    }

    const entry = fvg.high;
    const stop = orderBlock.low;
    if (stop >= entry) {
      return null;
    }

    const risk = entry - stop;
    const takeProfit = this.findTarget(entry, liquidity, risk);

    return new Signal({
      symbol: context.symbol,
      direction: Direction.Long,
      entry,
      stopLoss: stop,
      takeProfit,
      timeframe: this.ltf,
      timestamp: currentLtfTime,
      strategyName: this.name,
      strategyVersion: this.version,
      triggeredBy: ['4h_ob', '4h_discount', '15m_fvg', '15m_ssl_sweep'],
      meta: {
        ob_zone: [orderBlock.low, orderBlock.high],
        fvg_zone: [fvg.low, fvg.high],
      },
    });
  }

  /** Step 1: the most recent unmitigated bullish order block sitting in discount. */
  private selectOrderBlock(htfCandles: CandleSeries): Pattern | null {
    const orderBlocks = new OrderBlockDetector({
      swingLength: this.swingLengthHtf,
      lookback: this.obLookback,
      timeframe: this.htf,
    })
      .detect(htfCandles)
      .filter((p) => p.meta.direction === 'bullish' && p.meta.mitigated === false);

    if (orderBlocks.length === 0) {
      return null;
    }

    const discountZones = new PremiumDiscountDetector({
      swingLength: this.swingLengthHtf,
      timeframe: this.htf,
    })
      .detect(htfCandles)
      .filter((p) => p.meta.zone === 'discount');

    if (discountZones.length === 0) {
      return null;
    }

    const equilibrium = discountZones[discountZones.length - 1].meta.equilibrium as number;
    const candidates = orderBlocks.filter((ob) => ob.mid <= equilibrium);
    return latestByStartTime(candidates);
  }

  /** Step 2: an LTF bullish FVG being mitigated right now, overlapping the block. */
  private selectFvg(
    ltfCandles: CandleSeries,
    orderBlock: Pattern,
    currentTime: number,
  ): Pattern | null {
    const fvgs = new FvgDetector({ timeframe: this.ltf })
      .detect(ltfCandles)
      .filter(
        (p) =>
          p.meta.direction === 'bullish' &&
          p.endTime === currentTime && // the first touch is happening on this bar
          p.low < orderBlock.high &&
          p.high > orderBlock.low,
      );

    return latestByStartTime(fvgs);
  }

  /** Step 3: sell-side liquidity taken within the lookback window. */
  private sellSideRecentlySwept(ltfCandles: CandleSeries, liquidity: Pattern[]): boolean {
    const n = Math.min(this.liquiditySweepLookback, ltfCandles.length);
    // `index[-0]` is `index[0]` in Python, so a zero lookback means "from the
    // very first visible bar", not "from the end".
    const cutoff = ltfCandles.time[n === 0 ? 0 : ltfCandles.length - n];

    return liquidity.some(
      (p) =>
        p.meta.side === 'sell' &&
        p.meta.swept === true &&
        p.endTime !== null &&
        p.endTime >= cutoff,
    );
  }

  /** Step 4: nearest unswept buy-side liquidity above entry, else an RR target. */
  private findTarget(entry: number, liquidity: Pattern[], risk: number): number {
    const above = liquidity.filter(
      (p) => p.meta.side === 'buy' && p.meta.swept === false && p.high > entry,
    );
    if (above.length === 0) {
      return entry + risk * this.minRr;
    }

    // Python's min() keeps the FIRST minimal element on ties.
    let nearest = above[0];
    for (const candidate of above) {
      if (candidate.high < nearest.high) {
        nearest = candidate;
      }
    }
    return nearest.high;
  }
}

/** Python's `max(items, key=start_time)`: the FIRST maximal element on ties. */
function latestByStartTime(patterns: Pattern[]): Pattern | null {
  if (patterns.length === 0) {
    return null;
  }
  let latest = patterns[0];
  for (const pattern of patterns) {
    if (pattern.startTime > latest.startTime) {
      latest = pattern;
    }
  }
  return latest;
}
