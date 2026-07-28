import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candlesFromOhlc, HOUR_MS, T2024 } from '../../../test/fixtures/candles';
import { CandleSeries } from '../../domain/candle-series';
import { MarketContext } from '../../domain/market-context';
import { Pattern, PatternType } from '../../domain/pattern';
import { Direction, Signal } from '../../domain/signal';
import { Trade } from '../../domain/trade';
import { renderChart } from './chart.renderer';
import { renderFigureHtml } from './html.writer';
import { renderTrade, tradeTitle } from './trade-chart.renderer';

const bar = (i: number) => T2024 + i * HOUR_MS;

function series(count = 20): CandleSeries {
  return candlesFromOhlc(
    Array.from({ length: count }, (_, i) => ({
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 101 + i,
    })),
  );
}

function contextWith(count = 20): MarketContext {
  const context = new MarketContext('BTC/USDT', ['4h', '15m'], 500);
  context.load('4h', series(count));
  context.load('15m', series(count));
  return context;
}

function pattern(type: PatternType, meta: Record<string, unknown> = {}): Pattern {
  return new Pattern({
    type,
    timeframe: '4h',
    startTime: bar(2),
    endTime: bar(6),
    high: 110,
    low: 105,
    meta,
  });
}

function makeTrade(): Trade {
  const signal = new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry: 105,
    stopLoss: 100,
    takeProfit: 120,
    timeframe: '15m',
    timestamp: bar(5),
    strategyName: 'test',
    strategyVersion: '1.0',
  });
  const trade = new Trade({
    signal,
    orderId: 'order-1',
    entryTime: bar(5),
    entryPrice: 105,
    positionSize: 2,
  });
  trade.exitTime = bar(9);
  trade.exitPrice = 120;
  trade.exitReason = 'tp';
  return trade;
}

describe('renderChart', () => {
  it('puts one candlestick trace on the figure', () => {
    const figure = renderChart({ context: contextWith(), timeframe: '4h' });

    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].type).toBe('candlestick');
    expect((figure.data[0].x as string[])[0]).toBe(new Date(bar(0)).toISOString());
    expect(figure.layout.title).toBe('BTC/USDT — 4h');
  });

  it('clips the window to [start, end], both inclusive', () => {
    const figure = renderChart({
      context: contextWith(),
      timeframe: '4h',
      startMs: bar(3),
      endMs: bar(6),
    });

    expect(figure.data[0].x).toEqual(
      [bar(3), bar(4), bar(5), bar(6)].map((t) => new Date(t).toISOString()),
    );
  });

  it('refuses a timeframe with no candles', () => {
    const context = new MarketContext('BTC/USDT', ['4h'], 500);
    expect(() => renderChart({ context, timeframe: '4h' })).toThrow(/no candles/);
  });

  it('refuses an empty window', () => {
    expect(() =>
      renderChart({ context: contextWith(), timeframe: '4h', startMs: bar(100) }),
    ).toThrow(/No candles in the requested/);
  });

  describe('pattern dispatch', () => {
    it('draws a rectangle for zone-like patterns', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.OrderBlock, { direction: 'bullish', mitigated: false })],
      });

      const shapes = figure.layout.shapes as Record<string, unknown>[];
      expect(shapes).toHaveLength(1);
      expect(shapes[0].type).toBe('rect');
      expect(shapes[0].fillcolor).toBe('rgba(38, 166, 154, 0.30)');
      expect(shapes[0].y0).toBe(105);
      expect(shapes[0].y1).toBe(110);
    });

    it('fades a mitigated zone', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.OrderBlock, { direction: 'bullish', mitigated: true })],
      });
      expect((figure.layout.shapes as Record<string, unknown>[])[0].fillcolor).toBe(
        'rgba(38, 166, 154, 0.12)',
      );
    });

    it('draws a dotted line for swept liquidity', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.Liquidity, { side: 'buy', swept: true })],
      });

      const shape = (figure.layout.shapes as Record<string, unknown>[])[0];
      expect(shape.type).toBe('line');
      expect((shape.line as Record<string, unknown>).dash).toBe('dot');
      expect((shape.line as Record<string, unknown>).color).toBe('#78716c');
    });

    it('labels a structure break', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.Choch, { direction: 'bullish' })],
      });

      const annotations = figure.layout.annotations as Record<string, unknown>[];
      expect(annotations).toHaveLength(1);
      expect(annotations[0].text).toBe('CHOCH ↑');
    });

    it('draws the equilibrium only once per range', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [
          pattern(PatternType.PremiumDiscount, { zone: 'premium', equilibrium: 107 }),
          pattern(PatternType.PremiumDiscount, { zone: 'discount', equilibrium: 107 }),
        ],
      });

      const shapes = figure.layout.shapes as Record<string, unknown>[];
      // Two zone rectangles plus one equilibrium line.
      expect(shapes.filter((s) => s.type === 'rect')).toHaveLength(2);
      expect(shapes.filter((s) => s.type === 'line')).toHaveLength(1);
    });

    it('anchors a killzone band to the panel height', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.Killzone, { name: 'london_open' })],
      });

      const shape = (figure.layout.shapes as Record<string, unknown>[])[0];
      expect(shape.yref).toBe('paper');
      expect(shape.fillcolor).toBe('rgba(59, 130, 246, 0.10)');
    });

    it('shades the initial balance window and extends its levels to the right edge', () => {
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [pattern(PatternType.InitialBalance)],
      });

      const shapes = figure.layout.shapes as Record<string, unknown>[];

      // The shaded box covers only the formation window …
      const box = shapes.find((shape) => shape.type === 'rect');
      expect(box).toMatchObject({
        x0: new Date(bar(2)).toISOString(),
        x1: new Date(bar(6)).toISOString(),
        y0: 105,
        y1: 110,
      });

      // … while high, low and mid run from the IB close to the last bar, which
      // is what makes a later breakout of those levels readable on the chart.
      const levels = shapes.filter((shape) => shape.type === 'line');
      expect(levels.map((shape) => shape.y0)).toEqual([110, 105, 107.5]);
      for (const level of levels) {
        expect(level.x0).toBe(new Date(bar(6)).toISOString());
        expect(level.x1).toBe(new Date(bar(19)).toISOString());
      }
    });

    it('skips patterns outside the visible window', () => {
      const outside = new Pattern({
        type: PatternType.Fvg,
        timeframe: '4h',
        startTime: bar(50),
        endTime: bar(60),
        high: 10,
        low: 5,
        meta: { direction: 'bullish', mitigated: false },
      });
      const figure = renderChart({
        context: contextWith(),
        timeframe: '4h',
        patterns: [outside],
      });
      expect(figure.layout.shapes).toHaveLength(0);
    });
  });

  it('marks entries and exits of visible trades', () => {
    const figure = renderChart({
      context: contextWith(),
      timeframe: '15m',
      trades: [makeTrade()],
    });

    const annotations = figure.layout.annotations as Record<string, unknown>[];
    const entry = annotations.find((annotation) => annotation.showarrow === true);
    expect(entry).toMatchObject({
      x: new Date(bar(5)).toISOString(),
      y: 105,
      text: 'entry 105.0',
    });

    const exitTrace = figure.data[1];
    expect(exitTrace.mode).toBe('markers+text');
    expect(exitTrace.text).toEqual(['tp +14.29%']);
    expect(exitTrace.hovertext).toBe('exit: tp (+14.29%)');
  });

  it('draws the stop and target of a visible trade, labelled at the exit', () => {
    const figure = renderChart({
      context: contextWith(),
      timeframe: '15m',
      trades: [makeTrade()],
    });

    // Both levels run from the entry bar to the exit bar, not to the chart edge:
    // a closed trade's stop stops mattering once it is closed.
    const levels = (figure.layout.shapes as Record<string, unknown>[]).filter(
      (shape) => shape.type === 'line' && (shape.line as Record<string, unknown>).dash === 'dot',
    );
    expect(levels.map((shape) => shape.y0)).toEqual([100, 120]);
    for (const level of levels) {
      expect(level.x0).toBe(new Date(bar(5)).toISOString());
      expect(level.x1).toBe(new Date(bar(9)).toISOString());
    }

    const labels = (figure.layout.annotations as Record<string, unknown>[]).filter(
      (annotation) => annotation.showarrow !== true,
    );
    expect(labels.map((annotation) => annotation.text)).toEqual(['SL 100.0', 'TP 120.0']);
    for (const label of labels) {
      expect(label.x).toBe(new Date(bar(9)).toISOString());
    }
  });
});

describe('renderTrade', () => {
  const figure = renderTrade({
    trade: makeTrade(),
    context: contextWith(30),
    htf: '4h',
    ltf: '15m',
    barsBefore: 3,
    barsAfter: 3,
  });

  it('stacks two candlestick panels', () => {
    const candlesticks = figure.data.filter((trace) => trace.type === 'candlestick');
    expect(candlesticks).toHaveLength(2);
    expect(candlesticks[0].yaxis).toBe('y');
    expect(candlesticks[1].yaxis).toBe('y2');
  });

  it('binds trade levels to the lower panel', () => {
    const lines = (figure.layout.shapes as Record<string, unknown>[]).filter(
      (shape) => shape.type === 'line' && shape.yref === 'y2',
    );
    // Stop loss, take profit and entry.
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('extends the window so the exit stays on screen', () => {
    const ltfTrace = figure.data.filter((trace) => trace.type === 'candlestick')[1];
    const x = ltfTrace.x as string[];
    expect(x[x.length - 1] >= new Date(bar(9)).toISOString()).toBe(true);
  });

  it('titles itself with the outcome', () => {
    expect(figure.layout.title).toBe('BTC/USDT  LONG  @ 105.00  →  tp  +14.29%  +3.00R');
    expect(tradeTitle(makeTrade())).toBe(figure.layout.title);
  });
});

describe('html writer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a standalone page that loads Plotly from a CDN', () => {
    const path = join(dir, 'nested', 'chart.html');
    renderChart({ context: contextWith(), timeframe: '4h', savePath: path, title: 'My chart' });

    const html = readFileSync(path, 'utf8');
    expect(html).toContain('cdn.plot.ly');
    expect(html).toContain('Plotly.newPlot');
    expect(html).toContain('<title>My chart</title>');
    expect(html).toContain('"type":"candlestick"');
  });

  it('cannot be broken out of by a closing script tag in the data', () => {
    const html = renderFigureHtml({ data: [{ name: '</script><script>alert(1)' }], layout: {} });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('<\\/script>');
  });
});
