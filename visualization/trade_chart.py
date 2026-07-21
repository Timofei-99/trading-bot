from __future__ import annotations

from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from core.market_context import MarketContext
from core.patterns import Pattern, PatternType
from core.signal import Direction
from detectors.fvg import FVGDetector
from detectors.liquidity import LiquidityDetector
from detectors.order_blocks import OrderBlockDetector
from detectors.premium_discount import PremiumDiscountDetector
from execution.base import Trade
from visualization import style
from visualization.chart import (
    _draw_fvg,
    _draw_liquidity,
    _draw_order_block,
    _draw_premium_discount,
)


def render_trade(
    trade: Trade,
    context: MarketContext,
    htf: str,
    ltf: str,
    patterns_htf: list[Pattern] | None = None,
    patterns_ltf: list[Pattern] | None = None,
    bars_before: int = 100,
    bars_after: int = 50,
    save_path: str | Path | None = None,
) -> go.Figure:
    """Two-panel HTF/LTF chart focused on a single trade.

    - LTF window: `bars_before` bars before entry, `bars_after` bars after
      (or to exit if the trade lasted longer).
    - HTF window: candles that fall inside the same time range.
    - If `patterns_htf` / `patterns_ltf` are not provided, a default detector
      set is run on each TF and the resulting patterns are drawn.
    """
    htf_candles_all = context.candles(htf)
    ltf_candles_all = context.candles(ltf)
    if htf_candles_all.empty or ltf_candles_all.empty:
        raise ValueError("MarketContext lacks candles for one of the timeframes")

    entry_ts = pd.Timestamp(trade.entry_time)
    exit_ts = pd.Timestamp(trade.exit_time) if trade.exit_time is not None else None

    ltf_idx = ltf_candles_all.index
    entry_pos = int(ltf_idx.searchsorted(entry_ts, side="right")) - 1
    if entry_pos < 0:
        raise ValueError("Trade entry is before the earliest LTF candle")

    if exit_ts is not None:
        exit_pos = int(ltf_idx.searchsorted(exit_ts, side="right")) - 1
        after_needed = max(bars_after, exit_pos - entry_pos + 5)
    else:
        after_needed = bars_after

    lo_pos = max(0, entry_pos - bars_before)
    hi_pos = min(len(ltf_idx) - 1, entry_pos + after_needed)
    ltf_candles = ltf_candles_all.iloc[lo_pos : hi_pos + 1]

    x0, x1 = ltf_candles.index[0], ltf_candles.index[-1]
    htf_candles = htf_candles_all.loc[(htf_candles_all.index >= x0) & (htf_candles_all.index <= x1)]

    if patterns_htf is None:
        patterns_htf = _default_htf_patterns(htf_candles_all, htf)
    if patterns_ltf is None:
        patterns_ltf = _default_ltf_patterns(ltf_candles_all, ltf)

    fig = make_subplots(
        rows=2, cols=1,
        shared_xaxes=True,
        row_heights=[0.4, 0.6],
        vertical_spacing=0.04,
        subplot_titles=(f"{htf} — context", f"{ltf} — trigger"),
    )

    if not htf_candles.empty:
        fig.add_trace(
            go.Candlestick(
                x=htf_candles.index,
                open=htf_candles["open"], high=htf_candles["high"],
                low=htf_candles["low"], close=htf_candles["close"],
                increasing_line_color=style.CANDLE_UP,
                decreasing_line_color=style.CANDLE_DOWN,
                increasing_fillcolor=style.CANDLE_UP,
                decreasing_fillcolor=style.CANDLE_DOWN,
                showlegend=False, name=htf,
            ),
            row=1, col=1,
        )

    fig.add_trace(
        go.Candlestick(
            x=ltf_candles.index,
            open=ltf_candles["open"], high=ltf_candles["high"],
            low=ltf_candles["low"], close=ltf_candles["close"],
            increasing_line_color=style.CANDLE_UP,
            decreasing_line_color=style.CANDLE_DOWN,
            increasing_fillcolor=style.CANDLE_UP,
            decreasing_fillcolor=style.CANDLE_DOWN,
            showlegend=False, name=ltf,
        ),
        row=2, col=1,
    )

    _draw_panel_patterns(fig, patterns_htf, x0, x1, row=1)
    _draw_panel_patterns(fig, patterns_ltf, x0, x1, row=2)
    _draw_trade_markers(fig, trade, row=2)

    layout = dict(style.LAYOUT_DEFAULTS)
    layout.pop("xaxis", None)
    layout.pop("yaxis", None)
    layout["title"] = _trade_title(trade)
    fig.update_layout(**layout)

    for r in (1, 2):
        fig.update_xaxes(gridcolor=style.GRID, showgrid=True, rangeslider_visible=False, row=r, col=1)
        fig.update_yaxes(gridcolor=style.GRID, showgrid=True, row=r, col=1)

    if save_path is not None:
        Path(save_path).parent.mkdir(parents=True, exist_ok=True)
        fig.write_html(str(save_path), include_plotlyjs="cdn")

    return fig


def _default_htf_patterns(candles: pd.DataFrame, timeframe: str) -> list[Pattern]:
    return (
        OrderBlockDetector(timeframe=timeframe).detect(candles)
        + PremiumDiscountDetector(timeframe=timeframe).detect(candles)
    )


def _default_ltf_patterns(candles: pd.DataFrame, timeframe: str) -> list[Pattern]:
    return (
        FVGDetector(timeframe=timeframe).detect(candles)
        + LiquidityDetector(timeframe=timeframe).detect(candles)
    )


def _draw_panel_patterns(
    fig: go.Figure,
    patterns: list[Pattern],
    x0: pd.Timestamp,
    x1: pd.Timestamp,
    row: int,
) -> None:
    """Draw only patterns that overlap the visible window, using pre-row shape kwargs."""
    for p in patterns:
        start = pd.Timestamp(p.start_time)
        end = pd.Timestamp(p.end_time) if p.end_time is not None else x1
        if start > x1 or end < x0:
            continue

        right_edge = x1
        pre_shape_count = len(fig.layout.shapes)
        pre_ann_count = len(fig.layout.annotations)

        if p.type is PatternType.ORDER_BLOCK:
            _draw_order_block(fig, p, right_edge)
        elif p.type is PatternType.FVG:
            _draw_fvg(fig, p, right_edge)
        elif p.type is PatternType.LIQUIDITY:
            _draw_liquidity(fig, p, right_edge)
        elif p.type is PatternType.PREMIUM_DISCOUNT:
            _draw_premium_discount(fig, p, right_edge)
        else:
            continue

        _bind_shapes_to_row(fig, pre_shape_count, row)
        _bind_annotations_to_row(fig, pre_ann_count, row)


def _bind_shapes_to_row(fig: go.Figure, from_idx: int, row: int) -> None:
    xref = "x" if row == 1 else "x2"
    yref = "y" if row == 1 else "y2"
    shapes = list(fig.layout.shapes)
    for i in range(from_idx, len(shapes)):
        shapes[i].update(xref=xref, yref=yref)
    fig.layout.shapes = tuple(shapes)


def _bind_annotations_to_row(fig: go.Figure, from_idx: int, row: int) -> None:
    xref = "x" if row == 1 else "x2"
    yref = "y" if row == 1 else "y2"
    anns = list(fig.layout.annotations)
    for i in range(from_idx, len(anns)):
        anns[i].update(xref=xref, yref=yref)
    fig.layout.annotations = tuple(anns)


def _draw_trade_markers(fig: go.Figure, trade: Trade, row: int) -> None:
    is_long = trade.signal.direction == Direction.LONG

    fig.add_hline(
        y=trade.signal.stop_loss,
        line=dict(color=style.TRADE_SL, width=1, dash="dot"),
        annotation_text=f"SL {trade.signal.stop_loss:.2f}",
        annotation_position="right",
        annotation_font_color=style.TRADE_SL,
        row=row, col=1,
    )
    fig.add_hline(
        y=trade.signal.take_profit,
        line=dict(color=style.TRADE_TP, width=1, dash="dot"),
        annotation_text=f"TP {trade.signal.take_profit:.2f}",
        annotation_position="right",
        annotation_font_color=style.TRADE_TP,
        row=row, col=1,
    )
    fig.add_hline(
        y=trade.entry_price,
        line=dict(color=style.TRADE_ENTRY, width=1),
        annotation_text=f"Entry {trade.entry_price:.2f}",
        annotation_position="right",
        annotation_font_color=style.TRADE_ENTRY,
        row=row, col=1,
    )

    fig.add_annotation(
        x=trade.entry_time, y=trade.entry_price,
        ax=0, ay=30 if is_long else -30,
        arrowhead=2, arrowcolor=style.TRADE_ENTRY, arrowwidth=1.5,
        showarrow=True, text="entry",
        font=dict(color=style.TRADE_ENTRY, size=10),
        xref="x2", yref="y2",
    )

    if trade.exit_time is not None and trade.exit_price is not None:
        won = trade.is_winner
        exit_color = style.TRADE_EXIT_WIN if won else style.TRADE_EXIT_LOSS
        fig.add_trace(
            go.Scatter(
                x=[trade.exit_time], y=[trade.exit_price],
                mode="markers+text",
                marker=dict(color=exit_color, size=10, symbol="x"),
                text=[trade.exit_reason or ""],
                textposition="top center",
                textfont=dict(color=exit_color, size=10),
                showlegend=False,
            ),
            row=row, col=1,
        )


def _trade_title(trade: Trade) -> str:
    pnl_pct = (trade.pnl_pct or 0) * 100
    pnl_r = trade.pnl_r
    r_txt = f"  {pnl_r:+.2f}R" if pnl_r is not None else ""
    reason = trade.exit_reason or "open"
    return (
        f"{trade.signal.symbol}  {trade.signal.direction.value.upper()}  "
        f"@ {trade.entry_price:.2f}  →  {reason}  {pnl_pct:+.2f}%{r_txt}"
    )
