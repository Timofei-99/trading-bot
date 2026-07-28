# Deliberate divergences from the Python implementation

The migration's default rule is bit-exact parity with the Python stack on
`master`, enforced by the suites under `test/parity/`. This file records the
places where the TypeScript stack is **intentionally** different, so that a
missing parity check reads as a decision rather than an oversight.

Anything not listed here is expected to match exactly. If a parity suite goes
red, the answer is to fix the TypeScript — not to add an entry below.

---

## `frankfurt_ib_50` — rewritten as v2.0

**Commit:** `b91345c` · **Python baseline:** v1.0 · **TypeScript:** v2.0

The strategy was re-specified, not ported differently. Both versions compute
the Frankfurt initial balance from 1m bars and take one trade per session
date; everything about the trigger, the stop and the target changed.

| | Python v1.0 | TypeScript v2.0 |
|---|---|---|
| Trigger | consecutive closes straddling the IB **midpoint** | close beyond the IB **high or low** |
| Session timezone | `Europe/Berlin` | `UTC` |
| IB window | `sessionStart` + `ibDurationMinutes` | explicit `ibStart` … `ibEnd` |
| Entry window ends | `10:00` | `12:00` (into London) |
| Stop | nearest confirmed swing, else opposite IB edge | opposite IB edge, always |
| Target | full IB projection (IB range beyond the edge) | fixed 1:1 against the stop |
| Parameters | `sessionStart`, `ibDurationMinutes`, `swingLength` | `ibStart`, `ibEnd` (no swing lookup) |

### Consequences

- The run was removed from `test/parity/strategies-e2e.parity.spec.ts`. It is
  the only bundled strategy **without** an end-to-end parity gate; its
  correctness rests on `src/strategies/frankfurt-ib-50.strategy.spec.ts`
  alone. Treat changes to it with more care than the other two.
- `test/fixtures/golden/trades/frankfurt_ib50_synth.json` and
  `test/fixtures/golden/reports/frankfurt_ib50_synth.json` describe **v1.0**
  and are retained as the historical Python baseline, not as an active
  expectation. `test/parity/divergence.spec.ts` pins that mismatch so the
  fixtures cannot quietly start being read as current.
- `test/fixtures/golden/visibility/frankfurt_ib50_synth.json` **is** still
  live. It exercises the engine's bar-slicing over the `frankfurt_1m`
  dataset, which is independent of what the strategy decides, so the rewrite
  does not affect it.

### If parity is ever wanted back

Re-specifying v1.0 in TypeScript would make the golden fixtures usable again
as-is. Short of that, a new baseline would have to come from a Python
implementation of v2.0 — which does not exist and would have to be written to
serve as the oracle.

---

## `binance_adapter`

Not ported. On `master` it was a stub whose every method raised
`NotImplementedError`; the TypeScript stack ships a working Bybit adapter
(`src/infrastructure/execution/bybit.adapter.ts`) instead. There is no
behaviour to be parity-checked against.
