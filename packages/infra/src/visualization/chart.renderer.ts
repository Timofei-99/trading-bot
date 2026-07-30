import { MarketContext } from '@bot/core/domain/market-context';
import { Pattern } from '@bot/core/domain/pattern';
import { Direction } from '@bot/core/domain/signal';
import { Trade } from '@bot/core/domain/trade';
import { writeFigureHtml } from './html.writer';
import { drawPattern } from './pattern-drawers';
import { PlotlyFigure, PlotlyFigureBuilder } from './plotly-figure.builder';
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

  const defaults = style.layoutDefaults();
  builder.setLayout({
    ...defaults,
    title: options.title || `${options.context.symbol} — ${options.timeframe}`,
    xaxis: {
      ...(defaults.xaxis as object),
      range: [PlotlyFigureBuilder.time(x0), PlotlyFigureBuilder.time(x1)],
    },
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
