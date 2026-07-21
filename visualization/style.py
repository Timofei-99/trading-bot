from __future__ import annotations

BACKGROUND = "#131722"
GRID = "#1f2937"
TEXT = "#d1d5db"

CANDLE_UP = "#26a69a"
CANDLE_DOWN = "#ef5350"

OB_BULL_ACTIVE = "rgba(38, 166, 154, 0.30)"
OB_BULL_MIT    = "rgba(38, 166, 154, 0.12)"
OB_BEAR_ACTIVE = "rgba(239, 83, 80, 0.30)"
OB_BEAR_MIT    = "rgba(239, 83, 80, 0.12)"
OB_BORDER      = "rgba(255, 255, 255, 0.25)"

FVG_BULL_ACTIVE = "rgba(66, 165, 245, 0.28)"
FVG_BULL_MIT    = "rgba(66, 165, 245, 0.10)"
FVG_BEAR_ACTIVE = "rgba(255, 152, 0, 0.28)"
FVG_BEAR_MIT    = "rgba(255, 152, 0, 0.10)"

BSL_ACTIVE = "#facc15"
BSL_SWEPT  = "#78716c"
SSL_ACTIVE = "#facc15"
SSL_SWEPT  = "#78716c"

BOS_BULL = "#22c55e"
BOS_BEAR = "#ef4444"
CHOCH_BULL = "#a3e635"
CHOCH_BEAR = "#f87171"

PREMIUM = "rgba(239, 83, 80, 0.06)"
DISCOUNT = "rgba(38, 166, 154, 0.06)"
EQUILIBRIUM = "rgba(200, 200, 200, 0.3)"

KILLZONE_COLORS = {
    "asian":        "rgba(156, 163, 175, 0.10)",
    "london_open":  "rgba(59, 130, 246, 0.10)",
    "ny_open":      "rgba(168, 85, 247, 0.10)",
    "london_close": "rgba(236, 72, 153, 0.10)",
}

SNR_SUPPORT    = "rgba(38, 166, 154, 0.15)"
SNR_RESISTANCE = "rgba(239, 83, 80, 0.15)"
SNR_BROKEN     = "rgba(120, 113, 108, 0.10)"

IB_FILL   = "rgba(150, 150, 150, 0.15)"
IB_BORDER = "rgba(200, 200, 200, 0.35)"
IB_MID    = "rgba(220, 220, 220, 0.55)"

TRADE_ENTRY = "#3b82f6"
TRADE_SL    = "#ef4444"
TRADE_TP    = "#22c55e"
TRADE_EXIT_WIN  = "#22c55e"
TRADE_EXIT_LOSS = "#ef4444"


LAYOUT_DEFAULTS = dict(
    template="plotly_dark",
    paper_bgcolor=BACKGROUND,
    plot_bgcolor=BACKGROUND,
    font=dict(color=TEXT, size=11),
    xaxis=dict(gridcolor=GRID, showgrid=True, rangeslider=dict(visible=False)),
    yaxis=dict(gridcolor=GRID, showgrid=True),
    margin=dict(l=50, r=50, t=40, b=30),
    hovermode="x unified",
    showlegend=False,
)
