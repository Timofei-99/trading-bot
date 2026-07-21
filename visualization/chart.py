from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go

from core.market_context import MarketContext
from core.patterns import Pattern, PatternType
from core.signal import Direction
from execution.base import Trade
from visualization import style


def render_chart(
    context: MarketContext,
    timeframe: str,
    patterns: list[Pattern] | None = None,
    trades: list[Trade] | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    title: str = "",
    save_path: str | Path | None = None,
) -> go.Figure:
    """Render candles on the given timeframe with all supplied patterns and trades.

    Patterns are dispatched by PatternType — mixed lists from any detector work.
    The visible x-window is clipped to [start, end] (both inclusive) if given.
    """
    candles = context.candles(timeframe)
    if candles.empty:
        raise ValueError(f"MarketContext has no candles for timeframe {timeframe!r}")

    if start is not None:
        candles = candles.loc[candles.index >= pd.Timestamp(start)]
    if end is not None:
        candles = candles.loc[candles.index <= pd.Timestamp(end)]
    if candles.empty:
        raise ValueError("No candles in the requested [start, end] window")

    x0_visible = candles.index[0]
    x1_visible = candles.index[-1]
    right_edge = x1_visible

    fig = go.Figure()
    fig.add_trace(
        go.Candlestick(
            x=candles.index,
            open=candles["open"],
            high=candles["high"],
            low=candles["low"],
            close=candles["close"],
            increasing_line_color=style.CANDLE_UP,
            decreasing_line_color=style.CANDLE_DOWN,
            increasing_fillcolor=style.CANDLE_UP,
            decreasing_fillcolor=style.CANDLE_DOWN,
            name=context.symbol,
            showlegend=False,
        )
    )

    if patterns:
        _draw_patterns(fig, patterns, x0_visible, x1_visible, right_edge)

    if trades:
        _draw_trades(fig, trades, x0_visible, x1_visible)

    layout = dict(style.LAYOUT_DEFAULTS)
    layout["title"] = title or f"{context.symbol} — {timeframe}"
    fig.update_layout(**layout)

    if save_path is not None:
        Path(save_path).parent.mkdir(parents=True, exist_ok=True)
        fig.write_html(str(save_path), include_plotlyjs="cdn")

    return fig


def _draw_patterns(
    fig: go.Figure,
    patterns: list[Pattern],
    x0_visible: pd.Timestamp,
    x1_visible: pd.Timestamp,
    right_edge: pd.Timestamp,
) -> None:
    """Dispatch each pattern to its drawer based on PatternType."""
    for p in patterns:
        if not _overlaps_window(p, x0_visible, x1_visible):
            continue

        pt = p.type
        if pt is PatternType.ORDER_BLOCK:
            _draw_order_block(fig, p, right_edge)
        elif pt is PatternType.FVG:
            _draw_fvg(fig, p, right_edge)
        elif pt is PatternType.LIQUIDITY:
            _draw_liquidity(fig, p, right_edge)
        elif pt is PatternType.BOS or pt is PatternType.CHOCH:
            _draw_structure_break(fig, p)
        elif pt is PatternType.PREMIUM_DISCOUNT:
            _draw_premium_discount(fig, p, right_edge)
        elif pt is PatternType.KILLZONE:
            _draw_killzone(fig, p)
        elif pt is PatternType.SNR:
            _draw_snr(fig, p, right_edge)
        elif pt is PatternType.INITIAL_BALANCE:
            _draw_initial_balance(fig, p)


def _overlaps_window(p: Pattern, x0: pd.Timestamp, x1: pd.Timestamp) -> bool:
    start = pd.Timestamp(p.start_time)
    if start > x1:
        return False
    end = pd.Timestamp(p.end_time) if p.end_time is not None else x1
    return end >= x0


def _draw_order_block(fig: go.Figure, p: Pattern, right_edge: pd.Timestamp) -> None:
    direction = p.meta.get("direction", "bullish")
    mitigated = p.meta.get("mitigated", False)
    if direction == "bullish":
        color = style.OB_BULL_MIT if mitigated else style.OB_BULL_ACTIVE
    else:
        color = style.OB_BEAR_MIT if mitigated else style.OB_BEAR_ACTIVE
    x1 = p.end_time if p.end_time is not None else right_edge
    fig.add_shape(
        type="rect",
        x0=p.start_time, x1=x1,
        y0=p.low, y1=p.high,
        fillcolor=color,
        line=dict(color=style.OB_BORDER, width=1),
        layer="below",
    )


def _draw_fvg(fig: go.Figure, p: Pattern, right_edge: pd.Timestamp) -> None:
    direction = p.meta.get("direction", "bullish")
    mitigated = p.meta.get("mitigated", False)
    if direction == "bullish":
        color = style.FVG_BULL_MIT if mitigated else style.FVG_BULL_ACTIVE
    else:
        color = style.FVG_BEAR_MIT if mitigated else style.FVG_BEAR_ACTIVE
    x1 = p.end_time if p.end_time is not None else right_edge
    fig.add_shape(
        type="rect",
        x0=p.start_time, x1=x1,
        y0=p.low, y1=p.high,
        fillcolor=color,
        line=dict(width=0),
        layer="below",
    )


def _draw_liquidity(fig: go.Figure, p: Pattern, right_edge: pd.Timestamp) -> None:
    swept = p.meta.get("swept", False)
    side = p.meta.get("side", "buy")
    color = (style.BSL_SWEPT if swept else style.BSL_ACTIVE) if side == "buy" else \
            (style.SSL_SWEPT if swept else style.SSL_ACTIVE)
    dash = "dot" if swept else "solid"
    x1 = p.end_time if p.end_time is not None else right_edge
    fig.add_shape(
        type="line",
        x0=p.start_time, x1=x1,
        y0=p.high, y1=p.high,
        line=dict(color=color, width=1, dash=dash),
        layer="below",
    )


def _draw_structure_break(fig: go.Figure, p: Pattern) -> None:
    direction = p.meta.get("direction", "bullish")
    is_bos = p.type is PatternType.BOS
    if is_bos:
        color = style.BOS_BULL if direction == "bullish" else style.BOS_BEAR
        label = "BOS"
    else:
        color = style.CHOCH_BULL if direction == "bullish" else style.CHOCH_BEAR
        label = "CHOCH"
    break_time = p.end_time if p.end_time is not None else p.start_time
    fig.add_shape(
        type="line",
        x0=p.start_time, x1=break_time,
        y0=p.high, y1=p.high,
        line=dict(color=color, width=1, dash="dash"),
        layer="below",
    )
    fig.add_annotation(
        x=break_time, y=p.high,
        text=f"{label} {'↑' if direction == 'bullish' else '↓'}",
        showarrow=False,
        font=dict(color=color, size=10),
        yshift=8 if direction == "bullish" else -8,
    )


def _draw_premium_discount(fig: go.Figure, p: Pattern, right_edge: pd.Timestamp) -> None:
    zone = p.meta.get("zone", "premium")
    color = style.PREMIUM if zone == "premium" else style.DISCOUNT
    x1 = p.end_time if p.end_time is not None else right_edge
    fig.add_shape(
        type="rect",
        x0=p.start_time, x1=x1,
        y0=p.low, y1=p.high,
        fillcolor=color,
        line=dict(width=0),
        layer="below",
    )
    eq = p.meta.get("equilibrium")
    if eq is not None and zone == "premium":
        fig.add_shape(
            type="line",
            x0=p.start_time, x1=x1,
            y0=eq, y1=eq,
            line=dict(color=style.EQUILIBRIUM, width=1, dash="dot"),
            layer="below",
        )


def _draw_killzone(fig: go.Figure, p: Pattern) -> None:
    name = p.meta.get("name", "")
    color = style.KILLZONE_COLORS.get(name, "rgba(200, 200, 200, 0.06)")
    fig.add_vrect(
        x0=p.start_time,
        x1=p.end_time if p.end_time is not None else p.start_time,
        fillcolor=color,
        line_width=0,
        layer="below",
    )


def _draw_snr(fig: go.Figure, p: Pattern, right_edge: pd.Timestamp) -> None:
    side = p.meta.get("side", "support")
    broken = p.meta.get("broken", False)
    if broken:
        color = style.SNR_BROKEN
    else:
        color = style.SNR_SUPPORT if side == "support" else style.SNR_RESISTANCE
    x1 = p.end_time if p.end_time is not None else right_edge
    fig.add_shape(
        type="rect",
        x0=p.start_time, x1=x1,
        y0=p.low, y1=p.high,
        fillcolor=color,
        line=dict(width=0),
        layer="below",
    )


def _draw_initial_balance(fig: go.Figure, p: Pattern) -> None:
    fig.add_shape(
        type="rect",
        x0=p.start_time, x1=p.end_time,
        y0=p.low, y1=p.high,
        fillcolor=style.IB_FILL,
        line=dict(color=style.IB_BORDER, width=1),
        layer="below",
    )
    mid = p.meta.get("mid", (p.high + p.low) / 2)
    fig.add_shape(
        type="line",
        x0=p.start_time, x1=p.end_time,
        y0=mid, y1=mid,
        line=dict(color=style.IB_MID, width=1, dash="dot"),
        layer="below",
    )


def _draw_trades(
    fig: go.Figure,
    trades: list[Trade],
    x0_visible: pd.Timestamp,
    x1_visible: pd.Timestamp,
) -> None:
    for t in trades:
        entry_ts = pd.Timestamp(t.entry_time)
        if entry_ts < x0_visible or entry_ts > x1_visible:
            continue
        is_long = t.signal.direction == Direction.LONG
        arrow_color = style.TRADE_ENTRY
        fig.add_annotation(
            x=t.entry_time, y=t.entry_price,
            ax=0, ay=25 if is_long else -25,
            arrowhead=2, arrowcolor=arrow_color, arrowwidth=1.5,
            showarrow=True,
        )
        if t.exit_time is not None and t.exit_price is not None:
            won = t.is_winner
            exit_color = style.TRADE_EXIT_WIN if won else style.TRADE_EXIT_LOSS
            fig.add_trace(
                go.Scatter(
                    x=[t.exit_time], y=[t.exit_price],
                    mode="markers",
                    marker=dict(color=exit_color, size=8, symbol="x"),
                    showlegend=False,
                    hovertext=f"exit: {t.exit_reason} ({(t.pnl_pct or 0) * 100:+.2f}%)",
                )
            )
