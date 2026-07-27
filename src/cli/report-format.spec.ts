import { BacktestReport } from '../execution/backtest.adapter';
import { formatBacktestReport, formatReportLines, money0, profitFactor } from './report-format';

/** The numbers the Python run produced for the golden BTC replay. */
const GOLDEN_REPORT: BacktestReport = {
  totalTrades: 150,
  winners: 77,
  losers: 73,
  winRate: 0.5133333333333333,
  profitFactor: 0.9853018430440604,
  totalPnlPct: -0.006159605648802696,
  maxDrawdownPct: 0.16958635653609566,
};

describe('formatBacktestReport', () => {
  const rendered = formatBacktestReport(
    {
      symbol: 'BTC/USDT',
      strategyName: 'OB_4h_FVG_15m',
      strategyVersion: '1.0',
      initialBalance: 10_000,
      fromMs: Date.UTC(2023, 0, 1),
      toMs: Date.UTC(2024, 0, 1),
    },
    GOLDEN_REPORT,
  );

  it('reproduces the layout run_backtest.py printed', () => {
    expect(rendered).toBe(
      [
        '',
        '=== Backtest Report ===',
        '  Period          : 2023-01-01 – 2024-01-01',
        '  Symbol          : BTC/USDT',
        '  Strategy        : OB_4h_FVG_15m v1.0',
        '  Initial balance : $10,000',
        '  Total trades    : 150',
        '  Winners / Losers: 77 / 73',
        '  Win rate        : 51.3%',
        '  Profit factor   : 0.99',
        '  Total PnL       : -0.62%',
        '  Max drawdown    : 16.96%',
      ].join('\n'),
    );
  });

  it('omits the statistics block when nothing traded', () => {
    const empty = formatBacktestReport(
      {
        symbol: 'BTC/USDT',
        strategyName: 's',
        strategyVersion: '1',
        initialBalance: 1000,
        fromMs: null,
        toMs: null,
      },
      { ...GOLDEN_REPORT, totalTrades: 0 },
    );
    expect(empty).toContain('Total trades    : 0');
    expect(empty).not.toContain('Win rate');
    expect(empty).toContain('Period          : — – —');
  });

  it('shows a positive PnL with its sign', () => {
    expect(
      formatBacktestReport(
        {
          symbol: 'X',
          strategyName: 's',
          strategyVersion: '1',
          initialBalance: 1,
          fromMs: 0,
          toMs: 0,
        },
        { ...GOLDEN_REPORT, totalPnlPct: 0.1234 },
      ),
    ).toContain('Total PnL       : +12.34%');
  });
});

describe('number formatting', () => {
  it('groups the balance with thousands separators', () => {
    expect(money0(10_000)).toBe('$10,000');
    expect(money0(1_234_567.89)).toBe('$1,234,568');
  });

  it('prints an unbeatable profit factor as inf', () => {
    expect(profitFactor(Number.POSITIVE_INFINITY)).toBe('inf');
    expect(profitFactor(2)).toBe('2.00');
  });
});

describe('formatReportLines', () => {
  it('dumps one key per line, as the summary file did', () => {
    expect(formatReportLines({ ...GOLDEN_REPORT, totalTrades: 2 })).toContain('  totalTrades: 2');
  });
});
