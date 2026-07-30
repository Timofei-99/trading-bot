import { Pattern, PatternType } from '@bot/core/domain/pattern';

import { AxisRefs, PlotlyFigureBuilder } from './plotly-figure.builder';
import * as style from './style';

/**
 * One drawer per ICT concept — the visual half of `domain/pattern.ts`.
 *
 * Separated from `chart.renderer` because these are the part that changes:
 * a new detector needs a new drawer and nothing else, and none of them knows
 * anything about windows, panels or files. `drawPattern` is the only entry
 * point; the individual drawers stay private so the dispatch stays the single
 * place that maps a type to a shape.
 */

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

  // Full-height vertical band so the session window is visible at any price.
  builder.addVerticalBand(pattern.startTime, ibEnd, style.IB_SESSION_BAND, refs);

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
