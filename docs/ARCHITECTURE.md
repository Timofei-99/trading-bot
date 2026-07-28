# Architecture

Five npm workspaces, wired so that the dependency direction is a compile
error to violate rather than a convention to remember.

```
apps/cli    @bot/cli     nest-commander surface  ──┐
apps/api    @bot/api     HTTP surface  ──┐         │
                                         ▼         ▼
packages/app    @bot/app       orchestration (Nest DI)
                                         │
                     ┌───────────────────┴───────────┐
                     ▼                               │
packages/infra  @bot/infra   exchanges, files, charts│
                     │                               │
                     └───────────────┬───────────────┘
                                     ▼
packages/core   @bot/core    domain, detectors, strategies, engine, execution
                             (runtime dependency: luxon, and nothing else)
```

| package | contains | may import |
|---|---|---|
| `@bot/core` | `domain`, `detectors`, `strategies`, `engine`, `execution`, `version` | — |
| `@bot/infra` | ccxt/Yahoo repositories, MT5 loader, NDJSON cache and journal, Bybit adapter, Plotly renderers | `@bot/core` |
| `@bot/app` | strategy registry, backtest runner, candle source, report and run registries | `@bot/core`, `@bot/infra` |
| `@bot/api` | controllers, DTOs, `main.ts` | `@bot/core`, `@bot/app` |
| `@bot/cli` | commands, `cli.ts` | `@bot/core`, `@bot/infra`, `@bot/app` |

`test/` and `scripts/` sit at the root: the parity suites cut across every
package, and the downloaders are standalone tooling rather than part of the
app graph.

## Why `@bot/core` has no dependencies

The same strategy code runs under backtest, paper and live execution. That is
only true if it cannot tell which one it is in — so everything that talks to
an exchange, a clock, a disk or a chart sits behind a port declared in
`packages/core/src/domain/ports.ts` and implemented in `@bot/infra`.

`luxon` is the one exception, and it is a pure computation over IANA timezone
rules, not an I/O dependency.

## How the boundary is enforced

Three mechanisms, deliberately overlapping, because each misses something the
others catch.

**1. `tsc -b` — project references.** Each package's `tsconfig.json` maps only
the aliases its layer is allowed to use. `@bot/infra` inside `@bot/core` does
not resolve, so the build fails.

Worth knowing where this one is thin: because the workspace symlinks every
package into `node_modules/@bot/*`, TypeScript can *see* the declarations.
Under `moduleResolution: "node"` it refuses them, which is what produces the
error — but switching the repo to `node16`/`nodenext` would let the import
through. That is precisely why the eslint rule below is not redundant.

**2. eslint `no-restricted-imports`.** Deterministic, and independent of module
resolution. It also catches the case references structurally cannot: a package
reaching for the outside world directly (`ccxt`, `node:fs`), since those are
ordinary resolvable modules from anywhere.

**3. `test/workspace/packaging.spec.ts`.** Neither of the above notices a
*manifest* drifting from the source — a `@bot/*` dependency declared that the
layer is not allowed, a barrel added without an `exports` entry. Both stay
silent until a built artefact fails at runtime, which is the worst place to
learn about it.

## Resolution: three contexts, three mechanisms

The same specifier `@bot/core/domain/signal` is resolved three different ways,
and all three have to agree:

| context | mechanism |
|---|---|
| `tsc` | `paths` in each package's tsconfig, redirected to the referenced project's declarations |
| `jest` | `moduleNameMapper` → package **source**, so tests never depend on a current build |
| `node` (built) | the `exports` map in each package.json → `dist` |

The Node one has a sharp edge: declaring `exports` switches OFF directory
resolution, so `@bot/core/strategies` does *not* find
`dist/strategies/index.js` via the `./*` wildcard. Every barrel therefore needs
an explicit key, and `packaging.spec.ts` fails if one is missing.

## Build and check

```bash
npm run build       # tsc -b, emits packages/*/dist and apps/*/dist
npm run typecheck   # tsc -b (boundaries) + tsconfig.check.json (specs, test, scripts)
npm test            # jest against source
npm run verify      # format:check, lint, typecheck, test
```

`tsconfig.json` at the root is a build graph only — `files: []` plus
references. `tsconfig.check.json` is the wide net that typechecks specs,
`test/` and `scripts/`, which are not part of the build graph; it maps every
alias and therefore does **not** enforce boundaries. Enforcement is `tsc -b`.
