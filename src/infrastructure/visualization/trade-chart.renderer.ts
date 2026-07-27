import { FvgDetector } from '../../detectors/fvg.detector';
import { LiquidityDetector } from '../../detectors/liquidity.detector';
import { OrderBlockDetector } from '../../detectors/order-block.detector';
import { PremiumDiscountDetector } from '../../detectors/premium-discount.detector';
import { CandleSeries } from '../../domain/candle-series';
import { MarketContext } from '../../domain/market-context';
import { Pattern, PatternType } from '../../domain/pattern';
import { Direction } from '../../domain/signal';
import { Trade } from '../../domain/trade';
import { drawPattern, formatSigned } from './chart.renderer';
import { writeFigureHtml } from './html.writer';
import { PlotlyFigure, PlotlyFigureBuilder } from './plotly-figure.builder';
import * as style from './style';

export interface RenderTradeOptions {
  readonly trade: Trade;
  readonly context: MarketContext;
  readonly htf: string;
  readonly ltf: string;
  readonly patternsHtf?: readonly Pattern[];
  readonly patternsLtf?: readonly Pattern[];
  readonly barsBefore?: number;
  readonly barsAfter?: number;
  readonly savePath?: string;
}

/** Types the trade audit draws; anything else is context noise at this zoom. */
const AUDIT_TYPES = new Set<PatternType>([
  PatternType.OrderBlock,
  PatternType.Fvg,
  PatternType.Liquidity,
  PatternType.PremiumDiscount,
]);

/**
 * Two-panel audit of a single trade: HTF context on top, LTF trigger below.
 *
 * The LTF window spans `barsBefore` bars before entry and at least
 * `barsAfter` after — extended when the trade ran longer, so the exit is
 * always on screen. The HTF panel shows whatever falls in the same span.
 *
 * With no patterns supplied, a default detector set runs per timeframe: order
 * blocks and premium/discount for context, fair value gaps and liquidity for
 * the trigger.
 */
export function renderTrade(options: RenderTradeOptions): PlotlyFigure {
  const { trade } = options;
  const htfAll = options.context.candles(options.htf);
  const ltfAll = options.context.candles(options.ltf);
  if (htfAll.isEmpty || ltfAll.isEmpty) {
    throw new Error('MarketContext lacks candles for one of the timeframes');
  }

  const barsBefore = options.barsBefore ?? 100;
  const barsAfter = options.barsAfter ?? 50;

  const entryPos = ltfAll.searchSortedRight(trade.entryTime) - 1;
  if (entryPos < 0) {
    throw new Error('Trade entry is before the earliest LTF candle');
  }

  let afterNeeded = barsAfter;
  if (trade.exitTime !== null) {
    const exitPos = ltfAll.searchSortedRight(trade.exitTime) - 1;
    afterNeeded = Math.max(barsAfter, exitPos - entryPos + 5);
  }

  const lo = Math.max(0, entryPos - barsBefore);
  const hi = Math.min(ltfAll.length - 1, entryPos + afterNeeded);
  const ltf = ltfAll.slice(lo, hi + 1);

  const x0 = ltf.firstTime as number;
  const x1 = ltf.lastTime as number;
  const htf = htfAll.between(x0, x1);

  const patternsHtf = options.patternsHtf ?? defaultHtfPatterns(htfAll, options.htf);
  const patternsLtf = options.patternsLtf ?? defaultLtfPatterns(ltfAll, options.ltf);

  const builder = new PlotlyFigureBuilder();

  if (!htf.isEmpty) {
    builder.addCandlestick(htf, {
      name: options.htf,
      increasingColor: style.CANDLE_UP,
      decreasingColor: style.CANDLE_DOWN,
      xaxis: 'x',
      yaxis: 'y',
    });
  }
  builder.addCandlestick(ltf, {
    name: options.ltf,
    increasingColor: style.CANDLE_UP,
    decreasingColor: style.CANDLE_DOWN,
    xaxis: 'x2',
    yaxis: 'y2',
  });

  drawPanel(builder, patternsHtf, x0, x1, 'x', 'y');
  drawPanel(builder, patternsLtf, x0, x1, 'x2', 'y2');
  drawTradeMarkers(builder, trade, x0, x1);

  const layout = style.layoutDefaults();
  delete layout.xaxis;
  delete layout.yaxis;

  builder.setLayout({
    ...layout,
    title: tradeTitle(trade),
    grid: { rows: 2, columns: 1, pattern: 'independent' },
    // Top panel takes 40% of the height, bottom 60%, as the subplot did.
    xaxis: { gridcolor: style.GRID, showgrid: true, domain: [0, 1], anchor: 'y' },
    yaxis: { gridcolor: style.GRID, showgrid: true, domain: [0.62, 1] },
    xaxis2: {
      gridcolor: style.GRID,
      showgrid: true,
      domain: [0, 1],
      anchor: 'y2',
      rangeslider: { visible: false },
      matches: 'x',
    },
    yaxis2: { gridcolor: style.GRID, showgrid: true, domain: [0, 0.58] },
    annotations: [
      panelTitle(`${options.htf} — context`, 1),
      panelTitle(`${options.ltf} — trigger`, 0.58),
    ],
  });

  const figure = builder.build();
  if (options.savePath !== undefined) {
    writeFigureHtml(options.savePath, figure, tradeTitle(trade));
  }
  return figure;
}

function defaultHtfPatterns(candles: CandleSeries, timeframe: string): Pattern[] {
  return [
    ...new OrderBlockDetector({ timeframe }).detect(candles),
    ...new PremiumDiscountDetector({ timeframe }).detect(candles),
  ];
}

function defaultLtfPatterns(candles: CandleSeries, timeframe: string): Pattern[] {
  return [
    ...new FvgDetector({ timeframe }).detect(candles),
    ...new LiquidityDetector({ timeframe }).detect(candles),
  ];
}

function drawPanel(
  builder: PlotlyFigureBuilder,
  patterns: readonly Pattern[],
  x0: number,
  x1: number,
  xref: string,
  yref: string,
): void {
  for (const pattern of patterns) {
    const end = pattern.endTime ?? x1;
    if (pattern.startTime > x1 || end < x0) {
      continue;
    }
    if (!AUDIT_TYPES.has(pattern.type)) {
      continue;
    }
    drawPattern(builder, pattern, x1, { xref, yref });
  }
}

function drawTradeMarkers(
  builder: PlotlyFigureBuilder,
  trade: Trade,
  x0: number,
  x1: number,
): void {
  const levels: [number, string, string][] = [
    [trade.signal.stopLoss, style.TRADE_SL, 'SL'],
    [trade.signal.takeProfit, style.TRADE_TP, 'TP'],
    [trade.entryPrice, style.TRADE_ENTRY, 'Entry'],
  ];

  for (const [price, color, label] of levels) {
    builder.addLine({
      x0,
      x1,
      y0: price,
      y1: price,
      color,
      dash: label === 'Entry' ? undefined : 'dot',
      xref: 'x2',
      yref: 'y2',
    });
    builder.addAnnotation({
      x: PlotlyFigureBuilder.time(x1),
      y: price,
      text: `${label} ${price.toFixed(2)}`,
      xanchor: 'left',
      font: { color, size: 10 },
      xref: 'x2',
      yref: 'y2',
    });
  }

  builder.addAnnotation({
    x: PlotlyFigureBuilder.time(trade.entryTime),
    y: trade.entryPrice,
    ax: 0,
    ay: trade.signal.direction === Direction.Long ? 30 : -30,
    arrowhead: 2,
    arrowcolor: style.TRADE_ENTRY,
    arrowwidth: 1.5,
    showarrow: true,
    text: 'entry',
    font: { color: style.TRADE_ENTRY, size: 10 },
    xref: 'x2',
    yref: 'y2',
  });

  if (trade.exitTime !== null && trade.exitPrice !== null) {
    const color = trade.isWinner ? style.TRADE_EXIT_WIN : style.TRADE_EXIT_LOSS;
    builder.addScatter({
      x: [PlotlyFigureBuilder.time(trade.exitTime)],
      y: [trade.exitPrice],
      mode: 'markers+text',
      marker: { color, size: 10, symbol: 'x' },
      text: [trade.exitReason ?? ''],
      textposition: 'top center',
      textfont: { color, size: 10 },
      xaxis: 'x2',
      yaxis: 'y2',
    });
  }
}

function panelTitle(text: string, y: number): Record<string, unknown> {
  return {
    text,
    x: 0.5,
    y,
    xref: 'paper',
    yref: 'paper',
    xanchor: 'center',
    yanchor: 'bottom',
    showarrow: false,
    font: { color: style.TEXT, size: 12 },
  };
}

export function tradeTitle(trade: Trade): string {
  const pnlPct = (trade.pnlPct ?? 0) * 100;
  const pnlR = trade.pnlR;
  const rText = pnlR === null ? '' : `  ${formatSigned(pnlR, 2)}R`;
  const reason = trade.exitReason ?? 'open';

  return (
    `${trade.signal.symbol}  ${trade.signal.direction.toUpperCase()}  ` +
    `@ ${trade.entryPrice.toFixed(2)}  →  ${reason}  ${formatSigned(pnlPct, 2)}%${rText}`
  );
}
