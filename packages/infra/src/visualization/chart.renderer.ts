import { MarketContext } from '@bot/core/domain/market-context';
import { Pattern, PatternType } from '@bot/core/domain/pattern';
import { Direction } from '@bot/core/domain/signal';
import { Trade } from '@bot/core/domain/trade';
import { writeFigureHtml } from './html.writer';
import { AxisRefs, PlotlyFigure, PlotlyFigureBuilder } from './plotly-figure.builder';
import * as style from './style';

export interface RenderChartOptions {
  readonly context: MarketContext;
  readonly timeframe: string;
  readonly patterns?: readonly Pattern[];
  readonly trades?: readonly Trade[];
  readonly startMs?: number;
  readonly endMs?: number;
  readonly title?: string;
  readonly savePath?: string;
}

/**
 * One-panel chart: candles on a timeframe with every supplied pattern drawn
 * on top.
 *
 * Patterns are dispatched by type, so a mixed list from any combination of
 * detectors renders without the caller sorting it. Patterns that do not
 * overlap the visible window are skipped, and open-ended ones are drawn out to
 * the right edge.
 */
export function renderChart(options: RenderChartOptions): PlotlyFigure {
  const all = options.context.candles(options.timeframe);
  if (all.isEmpty) {
    throw new Error(
      `MarketContext has no candles for timeframe ${JSON.stringify(options.timeframe)}`,
    );
  }

  const candles = all.between(
    options.startMs ?? Number.NEGATIVE_INFINITY,
    options.endMs ?? Number.POSITIVE_INFINITY,
  );
  if (candles.isEmpty) {
    throw new Error('No candles in the requested [start, end] window');
  }

  const x0 = candles.firstTime as number;
  const x1 = candles.lastTime as number;

  const builder = new PlotlyFigureBuilder().addCandlestick(candles, {
    name: options.context.symbol,
    increasingColor: style.CANDLE_UP,
    decreasingColor: style.CANDLE_DOWN,
  });

  for (const pattern of options.patterns ?? []) {
    if (!overlapsWindow(pattern, x0, x1)) {
      continue;
    }
    drawPattern(builder, pattern, x1);
  }

  for (const trade of options.trades ?? []) {
    drawTradeMarker(builder, trade, x0, x1);
  }

  builder.setLayout({
    ...style.layoutDefaults(),
    title: options.title || `${options.context.symbol} — ${options.timeframe}`,
  });

  const figure = builder.build();
  if (options.savePath !== undefined) {
    writeFigureHtml(options.savePath, figure, options.title || options.context.symbol);
  }
  return figure;
}

export function overlapsWindow(pattern: Pattern, x0: number, x1: number): boolean {
  if (pattern.startTime > x1) {
    return false;
  }
  return (pattern.endTime ?? x1) >= x0;
}

/** Dispatch a pattern to its drawer. Unknown types are silently skipped. */
export function drawPattern(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs = {},
): boolean {
  switch (pattern.type) {
    case PatternType.OrderBlock:
      drawOrderBlock(builder, pattern, rightEdge, refs);
      return true;
    case PatternType.Fvg:
      drawFvg(builder, pattern, rightEdge, refs);
      return true;
    case PatternType.Liquidity:
      drawLiquidity(builder, pattern, rightEdge, refs);
      return true;
    case PatternType.Bos:
    case PatternType.Choch:
      drawStructureBreak(builder, pattern, refs);
      return true;
    case PatternType.PremiumDiscount:
      drawPremiumDiscount(builder, pattern, rightEdge, refs);
      return true;
    case PatternType.Killzone:
      drawKillzone(builder, pattern, refs);
      return true;
    case PatternType.Snr:
      drawSnr(builder, pattern, rightEdge, refs);
      return true;
    case PatternType.InitialBalance:
      drawInitialBalance(builder, pattern, rightEdge, refs);
      return true;
    default:
      return false;
  }
}

function drawOrderBlock(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const bullish = (pattern.meta.direction ?? 'bullish') === 'bullish';
  const mitigated = pattern.meta.mitigated === true;
  const fillcolor = bullish
    ? mitigated
      ? style.OB_BULL_MIT
      : style.OB_BULL_ACTIVE
    : mitigated
      ? style.OB_BEAR_MIT
      : style.OB_BEAR_ACTIVE;

  builder.addRect({
    x0: pattern.startTime,
    x1: pattern.endTime ?? rightEdge,
    y0: pattern.low,
    y1: pattern.high,
    fillcolor,
    line: { color: style.OB_BORDER, width: 1 },
    ...refs,
  });
}

function drawFvg(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const bullish = (pattern.meta.direction ?? 'bullish') === 'bullish';
  const mitigated = pattern.meta.mitigated === true;
  const fillcolor = bullish
    ? mitigated
      ? style.FVG_BULL_MIT
      : style.FVG_BULL_ACTIVE
    : mitigated
      ? style.FVG_BEAR_MIT
      : style.FVG_BEAR_ACTIVE;

  builder.addRect({
    x0: pattern.startTime,
    x1: pattern.endTime ?? rightEdge,
    y0: pattern.low,
    y1: pattern.high,
    fillcolor,
    ...refs,
  });
}

function drawLiquidity(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const swept = pattern.meta.swept === true;
  const buySide = (pattern.meta.side ?? 'buy') === 'buy';
  const color = buySide
    ? swept
      ? style.BSL_SWEPT
      : style.BSL_ACTIVE
    : swept
      ? style.SSL_SWEPT
      : style.SSL_ACTIVE;

  builder.addLine({
    x0: pattern.startTime,
    x1: pattern.endTime ?? rightEdge,
    y0: pattern.high,
    y1: pattern.high,
    color,
    dash: swept ? 'dot' : 'solid',
    ...refs,
  });
}

function drawStructureBreak(builder: PlotlyFigureBuilder, pattern: Pattern, refs: AxisRefs): void {
  const bullish = (pattern.meta.direction ?? 'bullish') === 'bullish';
  const isBos = pattern.type === PatternType.Bos;
  const color = isBos
    ? bullish
      ? style.BOS_BULL
      : style.BOS_BEAR
    : bullish
      ? style.CHOCH_BULL
      : style.CHOCH_BEAR;
  const label = isBos ? 'BOS' : 'CHOCH';
  const breakTime = pattern.endTime ?? pattern.startTime;

  builder.addLine({
    x0: pattern.startTime,
    x1: breakTime,
    y0: pattern.high,
    y1: pattern.high,
    color,
    dash: 'dash',
    ...refs,
  });
  builder.addAnnotation({
    x: PlotlyFigureBuilder.time(breakTime),
    y: pattern.high,
    text: `${label} ${bullish ? '↑' : '↓'}`,
    font: { color, size: 10 },
    yshift: bullish ? 8 : -8,
    ...refs,
  });
}

function drawPremiumDiscount(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const premium = (pattern.meta.zone ?? 'premium') === 'premium';
  const x1 = pattern.endTime ?? rightEdge;

  builder.addRect({
    x0: pattern.startTime,
    x1,
    y0: pattern.low,
    y1: pattern.high,
    fillcolor: premium ? style.PREMIUM : style.DISCOUNT,
    ...refs,
  });

  // Only the premium half draws the equilibrium, or every range would get two
  // identical dotted lines.
  const equilibrium = pattern.meta.equilibrium;
  if (premium && typeof equilibrium === 'number') {
    builder.addLine({
      x0: pattern.startTime,
      x1,
      y0: equilibrium,
      y1: equilibrium,
      color: style.EQUILIBRIUM,
      dash: 'dot',
      ...refs,
    });
  }
}

function drawKillzone(builder: PlotlyFigureBuilder, pattern: Pattern, refs: AxisRefs): void {
  const name = String(pattern.meta.name ?? '');
  builder.addVerticalBand(
    pattern.startTime,
    pattern.endTime ?? pattern.startTime,
    style.KILLZONE_COLORS[name] ?? style.KILLZONE_FALLBACK,
    refs,
  );
}

function drawSnr(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const broken = pattern.meta.broken === true;
  const support = (pattern.meta.side ?? 'support') === 'support';
  const fillcolor = broken ? style.SNR_BROKEN : support ? style.SNR_SUPPORT : style.SNR_RESISTANCE;

  builder.addRect({
    x0: pattern.startTime,
    x1: pattern.endTime ?? rightEdge,
    y0: pattern.low,
    y1: pattern.high,
    fillcolor,
    ...refs,
  });
}

function drawInitialBalance(
  builder: PlotlyFigureBuilder,
  pattern: Pattern,
  rightEdge: number,
  refs: AxisRefs,
): void {
  const ibEnd = pattern.endTime ?? pattern.startTime;

  // Shaded rectangle only over the IB formation window.
  builder.addRect({
    x0: pattern.startTime,
    x1: ibEnd,
    y0: pattern.low,
    y1: pattern.high,
    fillcolor: style.IB_FILL,
    line: { color: style.IB_BORDER, width: 1 },
    ...refs,
  });

  // High, low and mid lines extend to the right edge so breakout levels stay visible.
  const mid = typeof pattern.meta.mid === 'number' ? pattern.meta.mid : pattern.mid;
  for (const [y, color, dash] of [
    [pattern.high, style.IB_BORDER, 'solid'],
    [pattern.low, style.IB_BORDER, 'solid'],
    [mid, style.IB_MID, 'dot'],
  ] as [number, string, string][]) {
    builder.addLine({ x0: ibEnd, x1: rightEdge, y0: y, y1: y, color, dash, ...refs });
  }
}

function drawTradeMarker(builder: PlotlyFigureBuilder, trade: Trade, x0: number, x1: number): void {
  if (trade.entryTime < x0 || trade.entryTime > x1) {
    return;
  }
  const isLong = trade.signal.direction === Direction.Long;
  const lineEnd = trade.exitTime !== null ? Math.min(trade.exitTime, x1) : x1;

  // SL and TP dashed lines from entry to exit (or chart edge).
  for (const [y, color, label] of [
    [trade.signal.stopLoss, style.TRADE_SL, `SL ${trade.signal.stopLoss.toFixed(1)}`],
    [trade.signal.takeProfit, style.TRADE_TP, `TP ${trade.signal.takeProfit.toFixed(1)}`],
  ] as [number, string, string][]) {
    builder.addLine({ x0: trade.entryTime, x1: lineEnd, y0: y, y1: y, color, dash: 'dot' });
    builder.addAnnotation({
      x: PlotlyFigureBuilder.time(lineEnd),
      y,
      text: label,
      xanchor: 'left',
      font: { color, size: 10 },
    });
  }

  // Entry arrow.
  builder.addAnnotation({
    x: PlotlyFigureBuilder.time(trade.entryTime),
    y: trade.entryPrice,
    ax: 0,
    ay: isLong ? 30 : -30,
    arrowhead: 2,
    arrowcolor: style.TRADE_ENTRY,
    arrowwidth: 1.5,
    showarrow: true,
    text: `entry ${trade.entryPrice.toFixed(1)}`,
    font: { color: style.TRADE_ENTRY, size: 10 },
  });

  // Exit marker.
  if (trade.exitTime !== null && trade.exitPrice !== null) {
    const color = trade.isWinner ? style.TRADE_EXIT_WIN : style.TRADE_EXIT_LOSS;
    builder.addScatter({
      x: [PlotlyFigureBuilder.time(trade.exitTime)],
      y: [trade.exitPrice],
      mode: 'markers+text',
      marker: { color, size: 10, symbol: 'x' },
      text: [`${trade.exitReason} ${formatSigned((trade.pnlPct ?? 0) * 100, 2)}%`],
      textposition: 'top center',
      textfont: { color, size: 10 },
      hovertext: `exit: ${trade.exitReason} (${formatSigned((trade.pnlPct ?? 0) * 100, 2)}%)`,
    });
  }
}

export function formatSigned(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}
