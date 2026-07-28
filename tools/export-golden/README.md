# Golden fixture exporters

The parity suites under `test/parity/` compare the TypeScript stack against
fixtures produced by the original Python implementation (kept on `master`).
Comparison is **exact**, not approximate — Python floats, numpy float64 and JS
numbers are all IEEE-754 doubles, so identical operations in identical order
give identical bits, and an epsilon would hide exactly the drift the suites
exist to catch.

## `export_reports.py`

Rebuilds `test/fixtures/golden/reports/*.json` from
`test/fixtures/golden/trades/*.json`.

```bash
python3.11 tools/export-golden/export_reports.py
```

Requires **Python 3.11** and nothing else — no pandas, no numpy, no ccxt, no
network. The script refuses to run on any other minor version.

### Why 3.11 exactly

`sum()` accumulates naively through 3.11 and switched to Neumaier compensated
summation in 3.12. `gross_profit`, `gross_loss`, `total_pnl_pct` and the
`profit_factor` derived from them differ in the last bits between the two.
`manifest.json` pins 3.11.15 for this reason, and the TypeScript
`BacktestAdapter.report()` mirrors the naive accumulation deliberately
(`src/execution/backtest.adapter.ts:201`).

### Why it derives reports from trades

A report is a pure function of the closed-trade list, and the trade lists are
already pinned bit-for-bit against Python. Rebuilding a report therefore does
not require replaying a year of bars, an exchange, or the Python dependency
stack.

The aggregation is a verbatim port of `BacktestAdapter.report()` from
`master:execution/backtest_adapter.py:91`. It is deliberately **not** derived
from the TypeScript implementation it checks — golden data computed by the
code under test proves nothing. The TS engine replays the bars and computes
its own report; the fixture comes from Python's formulas applied to Python's
trades. The two meeting is a real result.

## History

`manifest.json` credits `scripts/export_golden.py` for every golden file. That
script was never committed and is not recoverable from any branch. The trade,
candle, detector and visibility fixtures it produced survive in the repo; the
report fixtures did not, because `.gitignore` carried an unanchored `reports/`
rule that also matched `test/fixtures/golden/reports/`. The rule is now
anchored (`/reports/`), and `test/parity/manifest.spec.ts` fails if any file
listed in the manifest is missing from disk.

Regenerating the other fixture families would need the Python stack from
`master` plus pandas, numpy and ccxt; it is out of scope here and unnecessary
while those fixtures are present and passing.
