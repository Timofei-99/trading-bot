#!/usr/bin/env python3.11
"""Regenerate the golden backtest reports from the golden trade lists.

WHY THIS EXISTS SEPARATELY FROM THE TRADES
------------------------------------------
`manifest.json` credits `scripts/export_golden.py` for every golden file, but
that script was never committed. The trade lists it produced survive; the
report files it produced were swallowed by an unanchored `reports/` rule in
`.gitignore` and never reached the repo, which left the end-to-end parity
suite unable to even load.

A report is a pure function of the closed-trade list, and the trade lists are
already pinned bit-for-bit against the Python stack. So the reports can be
rebuilt without replaying a year of bars — and, more importantly, without
network access, pandas, numpy or ccxt.

INDEPENDENCE
------------
The aggregation below is a verbatim port of `BacktestAdapter.report()` from
the Python implementation on `master` (`execution/backtest_adapter.py:91`).
It is deliberately NOT derived from the TypeScript implementation it is meant
to check: golden data computed by the code under test proves nothing.

PYTHON 3.11 IS REQUIRED, NOT A PREFERENCE
-----------------------------------------
`sum()` accumulates naively through 3.11 and switched to Neumaier compensated
summation in 3.12. `gross_profit`, `gross_loss`, `total_pnl_pct` and the
`profit_factor` derived from them differ in the last bits between the two, and
the parity suite compares exactly. The `sum()` calls below are kept as `sum()`
rather than rewritten as explicit loops precisely so that running this under
the wrong interpreter fails loudly instead of drifting quietly.

Usage:
    python3.11 tools/export-golden/export_reports.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

GOLDEN = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "golden"

# Pinned in manifest.json; see the module docstring for why this is exact.
REQUIRED_PYTHON = (3, 11)


def report(closed: list[dict]) -> dict:
    """Verbatim port of master:execution/backtest_adapter.py `report()`."""
    if not closed:
        return {
            "total_trades": 0,
            "winners": 0,
            "losers": 0,
            "win_rate": 0.0,
            "profit_factor": 0.0,
            "total_pnl_pct": 0.0,
            "max_drawdown_pct": 0.0,
        }

    winners = [t for t in closed if t["isWinner"]]
    losers = [t for t in closed if not t["isWinner"]]

    gross_profit = sum(t["pnlPct"] for t in winners if t["pnlPct"] is not None)
    gross_loss = abs(sum(t["pnlPct"] for t in losers if t["pnlPct"] is not None))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

    cumulative = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in closed:
        pnl = t["pnlPct"] or 0.0
        cumulative += pnl
        if cumulative > peak:
            peak = cumulative
        dd = peak - cumulative
        if dd > max_dd:
            max_dd = dd

    return {
        "total_trades": len(closed),
        "winners": len(winners),
        "losers": len(losers),
        "win_rate": len(winners) / len(closed),
        "profit_factor": profit_factor,
        "total_pnl_pct": sum(t["pnlPct"] for t in closed if t["pnlPct"] is not None),
        "max_drawdown_pct": max_dd,
    }


def to_golden(raw: dict) -> dict:
    """Python's snake_case result in the shape `GoldenReport` expects.

    `Infinity` has no JSON literal, so an infinite profit factor (no losing
    trades) is written as a string and decoded by `goldenNumber()` in
    test/fixtures/helpers.ts.
    """
    factor = raw["profit_factor"]
    return {
        "totalTrades": raw["total_trades"],
        "winners": raw["winners"],
        "losers": raw["losers"],
        "winRate": raw["win_rate"],
        "profitFactor": factor
        if factor not in (float("inf"), float("-inf"))
        else ("inf" if factor > 0 else "-inf"),
        "totalPnlPct": raw["total_pnl_pct"],
        "maxDrawdownPct": raw["max_drawdown_pct"],
    }


def main() -> int:
    if sys.version_info[:2] != REQUIRED_PYTHON:
        print(
            f"refusing to run on Python {sys.version_info.major}."
            f"{sys.version_info.minor}: the golden reports are pinned to "
            f"{REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]} because sum() changed "
            "accumulation strategy in 3.12 (see the module docstring)",
            file=sys.stderr,
        )
        return 1

    trades_dir = GOLDEN / "trades"
    reports_dir = GOLDEN / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    runs = sorted(path.stem for path in trades_dir.glob("*.json"))
    if not runs:
        print(f"no trade fixtures under {trades_dir}", file=sys.stderr)
        return 1

    for run in runs:
        payload = json.loads((trades_dir / f"{run}.json").read_text())
        golden = to_golden(report(payload["closedTrades"]))
        # `allow_nan=False` so a NaN never reaches a fixture as the bare
        # `NaN` literal, which is not valid JSON and would blow up JSON.parse.
        (reports_dir / f"{run}.json").write_text(
            json.dumps(golden, allow_nan=False) + "\n"
        )
        print(
            f"{run}: {golden['totalTrades']} trades, "
            f"pnl {golden['totalPnlPct']}, pf {golden['profitFactor']}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
