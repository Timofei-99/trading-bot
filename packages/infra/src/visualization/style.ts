/** Chart palette, carried over value-for-value from `visualization/style.py`. */

export const BACKGROUND = '#131722';
export const GRID = '#1f2937';
export const TEXT = '#d1d5db';

export const CANDLE_UP = '#26a69a';
export const CANDLE_DOWN = '#ef5350';

export const OB_BULL_ACTIVE = 'rgba(38, 166, 154, 0.30)';
export const OB_BULL_MIT = 'rgba(38, 166, 154, 0.12)';
export const OB_BEAR_ACTIVE = 'rgba(239, 83, 80, 0.30)';
export const OB_BEAR_MIT = 'rgba(239, 83, 80, 0.12)';
export const OB_BORDER = 'rgba(255, 255, 255, 0.25)';

export const FVG_BULL_ACTIVE = 'rgba(66, 165, 245, 0.28)';
export const FVG_BULL_MIT = 'rgba(66, 165, 245, 0.10)';
export const FVG_BEAR_ACTIVE = 'rgba(255, 152, 0, 0.28)';
export const FVG_BEAR_MIT = 'rgba(255, 152, 0, 0.10)';

export const BSL_ACTIVE = '#facc15';
export const BSL_SWEPT = '#78716c';
export const SSL_ACTIVE = '#facc15';
export const SSL_SWEPT = '#78716c';

export const BOS_BULL = '#22c55e';
export const BOS_BEAR = '#ef4444';
export const CHOCH_BULL = '#a3e635';
export const CHOCH_BEAR = '#f87171';

export const PREMIUM = 'rgba(239, 83, 80, 0.06)';
export const DISCOUNT = 'rgba(38, 166, 154, 0.06)';
export const EQUILIBRIUM = 'rgba(200, 200, 200, 0.3)';

export const KILLZONE_COLORS: Readonly<Record<string, string>> = {
  asian: 'rgba(156, 163, 175, 0.10)',
  london_open: 'rgba(59, 130, 246, 0.10)',
  ny_open: 'rgba(168, 85, 247, 0.10)',
  london_close: 'rgba(236, 72, 153, 0.10)',
};
export const KILLZONE_FALLBACK = 'rgba(200, 200, 200, 0.06)';

export const SNR_SUPPORT = 'rgba(38, 166, 154, 0.15)';
export const SNR_RESISTANCE = 'rgba(239, 83, 80, 0.15)';
export const SNR_BROKEN = 'rgba(120, 113, 108, 0.10)';

export const IB_SESSION_BAND = 'rgba(245, 158, 11, 0.10)';
export const IB_FILL = 'rgba(245, 158, 11, 0.20)';
export const IB_BORDER = 'rgba(245, 158, 11, 0.60)';
export const IB_MID = 'rgba(245, 158, 11, 0.80)';

export const TRADE_ENTRY = '#3b82f6';
export const TRADE_SL = '#ef4444';
export const TRADE_TP = '#22c55e';
export const TRADE_EXIT_WIN = '#22c55e';
export const TRADE_EXIT_LOSS = '#ef4444';

export interface PlotlyLayout {
  [key: string]: unknown;
}

export function layoutDefaults(): PlotlyLayout {
  return {
    template: 'plotly_dark',
    paper_bgcolor: BACKGROUND,
    plot_bgcolor: BACKGROUND,
    font: { color: TEXT, size: 11 },
    xaxis: { gridcolor: GRID, showgrid: true, rangeslider: { visible: false } },
    yaxis: { gridcolor: GRID, showgrid: true },
    margin: { l: 50, r: 50, t: 40, b: 30 },
    hovermode: 'x unified',
    showlegend: false,
  };
}
