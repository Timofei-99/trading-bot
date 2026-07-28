# `config/strategies/`

Drop a `.yaml` file here to register a strategy without writing TypeScript.

Every file names an `implementation` — a bundled strategy class the registry
already knows how to build — and supplies the id, version, timeframes and
parameters it should be registered under. Two parameterisations of the same
class are therefore two addressable strategies.

```yaml
id: aggressive_ob
version: "1.0"
description: OB_4h_FVG_15m with a tighter RR floor
implementation: OB_4h_FVG_15m      # see `npm run cli -- strategies`
timeframes: ["4h", "15m"]
params:
  minRr: 1.2                        # only what differs from the built-in
```

Parameters layer: the implementation's defaults, then this file, then
`--params` on the command line. A file only has to state what it changes.

Working examples: [`docs/examples/strategies/`](../../docs/examples/strategies).

This directory ships empty on purpose — the bundled strategies are registered
in TypeScript, and shipping YAML duplicates of them would just double the
output of `strategies`. Anything you add here is additive, except that reusing
a built-in id overrides it (deliberate, and logged at startup).

Malformed files are fatal at startup rather than skipped: a strategy that
silently fails to register first shows up as a backtest that quietly does not
run.
