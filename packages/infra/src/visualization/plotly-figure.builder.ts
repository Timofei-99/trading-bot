import { CandleSeries } from '@bot/core/domain/candle-series';
import { PlotlyLayout } from './style';

export interface PlotlyFigure {
  data: Record<string, unknown>[];
  layout: PlotlyLayout;
}

export interface AxisRefs {
  /** `x` / `y` for the first panel, `x2` / `y2` for the second. */
  readonly xref?: string;
  readonly yref?: string;
  readonly xaxis?: string;
  readonly yaxis?: string;
}

export interface CandlestickOptions extends AxisRefs {
  readonly name: string;
  readonly increasingColor: string;
  readonly decreasingColor: string;
}

export interface RectOptions extends AxisRefs {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly fillcolor: string;
  readonly line?: Record<string, unknown>;
}

export interface LineOptions extends AxisRefs {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly color: string;
  readonly width?: number;
  readonly dash?: string;
}

/**
 * Assembles a Plotly figure as plain JSON.
 *
 * Plotly is not a dependency: the browser loads it from a CDN and this only
 * has to produce the `{data, layout}` object it is handed — which is exactly
 * what the Python side shipped too, via `include_plotlyjs="cdn"`.
 *
 * Charts are built in layers (candles, then zones, then levels, then trade
 * markers), so a builder keeps each drawing routine to a couple of lines
 * instead of the 300-line functions the Python modules had grown into.
 */
export class PlotlyFigureBuilder {
  private readonly traces: Record<string, unknown>[] = [];
  private readonly shapes: Record<string, unknown>[] = [];
  private readonly annotations: Record<string, unknown>[] = [];
  private layout: PlotlyLayout = {};

  /** Plotly reads datetimes as ISO-8601 strings. */
  static timeAxis(series: CandleSeries): string[] {
    const out: string[] = [];
    for (let i = 0; i < series.length; i++) {
      out.push(new Date(series.time[i]).toISOString());
    }
    return out;
  }

  static time(ms: number): string {
    return new Date(ms).toISOString();
  }

  get shapeCount(): number {
    return this.shapes.length;
  }

  get annotationCount(): number {
    return this.annotations.length;
  }

  addCandlestick(series: CandleSeries, options: CandlestickOptions): this {
    this.traces.push({
      type: 'candlestick',
      x: PlotlyFigureBuilder.timeAxis(series),
      open: Array.from(series.open),
      high: Array.from(series.high),
      low: Array.from(series.low),
      close: Array.from(series.close),
      increasing: { line: { color: options.increasingColor }, fillcolor: options.increasingColor },
      decreasing: { line: { color: options.decreasingColor }, fillcolor: options.decreasingColor },
      name: options.name,
      showlegend: false,
      ...(options.xaxis === undefined ? {} : { xaxis: options.xaxis }),
      ...(options.yaxis === undefined ? {} : { yaxis: options.yaxis }),
    });
    return this;
  }

  addScatter(trace: Record<string, unknown>): this {
    this.traces.push({ type: 'scatter', showlegend: false, ...trace });
    return this;
  }

  addRect(options: RectOptions): this {
    this.shapes.push({
      type: 'rect',
      x0: PlotlyFigureBuilder.time(options.x0),
      x1: PlotlyFigureBuilder.time(options.x1),
      y0: options.y0,
      y1: options.y1,
      fillcolor: options.fillcolor,
      line: options.line ?? { width: 0 },
      layer: 'below',
      ...this.refs(options),
    });
    return this;
  }

  addLine(options: LineOptions): this {
    this.shapes.push({
      type: 'line',
      x0: PlotlyFigureBuilder.time(options.x0),
      x1: PlotlyFigureBuilder.time(options.x1),
      y0: options.y0,
      y1: options.y1,
      line: {
        color: options.color,
        width: options.width ?? 1,
        ...(options.dash === undefined ? {} : { dash: options.dash }),
      },
      layer: 'below',
      ...this.refs(options),
    });
    return this;
  }

  /** Full-height vertical band, the port of `add_vrect`. */
  addVerticalBand(x0: number, x1: number, fillcolor: string, refs: AxisRefs = {}): this {
    this.shapes.push({
      type: 'rect',
      x0: PlotlyFigureBuilder.time(x0),
      x1: PlotlyFigureBuilder.time(x1),
      y0: 0,
      y1: 1,
      yref: refs.yref === undefined ? 'paper' : `${refs.yref} domain`,
      fillcolor,
      line: { width: 0 },
      layer: 'below',
      ...(refs.xref === undefined ? {} : { xref: refs.xref }),
    });
    return this;
  }

  addAnnotation(annotation: Record<string, unknown>): this {
    this.annotations.push({ showarrow: false, ...annotation });
    return this;
  }

  /** Retarget shapes and annotations added since a mark onto another panel. */
  bindSince(shapeMark: number, annotationMark: number, xref: string, yref: string): this {
    for (let i = shapeMark; i < this.shapes.length; i++) {
      const shape = this.shapes[i];
      shape.xref = xref;
      // Vertical bands already anchor to the panel's full height.
      shape.yref =
        typeof shape.yref === 'string' && shape.yref.endsWith('domain') ? `${yref} domain` : yref;
    }
    for (let i = annotationMark; i < this.annotations.length; i++) {
      this.annotations[i].xref = xref;
      this.annotations[i].yref = yref;
    }
    return this;
  }

  setLayout(layout: PlotlyLayout): this {
    this.layout = { ...this.layout, ...layout };
    return this;
  }

  build(): PlotlyFigure {
    return {
      data: this.traces,
      layout: {
        ...this.layout,
        shapes: this.shapes,
        annotations: [
          ...((this.layout.annotations as Record<string, unknown>[] | undefined) ?? []),
          ...this.annotations,
        ],
      },
    };
  }

  private refs(options: AxisRefs): Record<string, string> {
    const out: Record<string, string> = {};
    if (options.xref !== undefined) {
      out.xref = options.xref;
    }
    if (options.yref !== undefined) {
      out.yref = options.yref;
    }
    return out;
  }
}
