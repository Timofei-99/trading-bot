# trading-bot

Toolkit for building and running ICT / Smart Money Concepts trading strategies: a look-ahead-free backtest engine, composable pattern detectors, dry-run paper trading on live data, and live execution against Bybit spot.

You write the strategy; the toolkit runs it — unchanged — under backtest, paper and live.

```bash
npm install
npm run seed-cache                   # fill the candle cache from committed fixtures
npm run cli -- --help
```

## The three modes

| Mode | Command | Data | Money |
|---|---|---|---|
| Backtest | `npm run cli -- backtest:ob4h --fee 0.001` | history | none |
| Paper (dry run) | `npm run cli -- paper` | live | none, simulated fills |
| Live | `npm run cli -- trade` | live | **testnet** by default |

Always judge a strategy with costs on. The gross backtest flatters everything: a year of BTC on the bundled strategy reads −0.62% gross and **−30.6% with Bybit's 0.1% spot taker fee**.

## Writing a strategy

1. `src/strategies/my.strategy.ts` — extend `Strategy`, implement `checkEntry(context): Signal | null`. Use `context.candles('15m')` and any detector from `src/detectors/`. `Signal.entry` must be a level derived from *earlier* bars, never the current bar's OHLC.
2. Add one entry to `BUILT_IN_STRATEGIES` in `src/application/strategy-registry.service.ts`.
3. Run it: `npm run cli -- paper --strategy MY_ID --params '{"minRr":3}'`.

See `CLAUDE.md` for the architecture and the invariants worth preserving.

## Live trading

Credentials come from the environment. Nothing else reads them, and the secret is never logged.

```bash
export BYBIT_API_KEY=...
export BYBIT_API_SECRET=...
# optional: BYBIT_CATEGORY=spot|linear
```

**Sandbox is the default.** Leaving it needs two independent signals — `BYBIT_LIVE=true` *and* `--live` — plus typed confirmation. Either one alone is refused by name.

### Stopping a bot

```bash
npm run cli -- halt   --journal data/journal/<file>.ndjson --reason "why"
npm run cli -- resume --journal data/journal/<file>.ndjson
```

A halt is written to the journal, so it stops the bot at its next tick **and survives a restart** — a loss limit a restart clears is not a loss limit. Halting cancels resting entries but deliberately leaves an open position alone: its stop is already at the venue, and selling at market on the way out realizes a loss the stop might never have taken. Close it yourself if you want out.

Automatic halts: `--max-daily-dd 0.03` (daily realized loss) and `--max-losses 4` (consecutive losers).

## Go-live checklist

Do not skip steps. Each one has caught a real class of problem.

**Before the strategy is allowed near a venue**
- [ ] Backtest **with costs**: `--fee 0.001 --slippage 0.0005 --worst-case`. Profit factor above 1 net of costs, or stop here.
- [ ] Read the trade list, not just the summary. Do entries sit at levels price actually revisits?

**Paper, on live data — at least two weeks**
- [ ] `npm run cli -- paper` running continuously.
- [ ] Compare paper fills against the backtest's. A large gap means the backtest assumes fills the market will not give you.
- [ ] Kill the process mid-position and restart it. State must come back identical.

**Testnet — at least one week**
- [ ] `npm run cli -- trade` (sandbox is the default). Get real order rejections, real precision errors, real timeouts.
- [ ] Verify TP/SL are visible **in the Bybit UI**, not just in the log. They must exist at the venue, not in this process.
- [ ] Kill the process while an order rests, restart, confirm reconciliation adopts or drops it correctly.
- [ ] Practice `halt` and confirm the bot stops opening positions.

**Only then, real funds**
- [ ] API key: trading enabled, **withdrawal disabled**, IP allowlist set.
- [ ] Start with an amount you would shrug off entirely.
- [ ] `--max-daily-dd` and `--max-losses` set. A bot without a kill switch is not a bot, it is a leak.
- [ ] Know how to stop it — `halt`, and how to close a position by hand in the UI.
- [ ] Watch the first day. Read `data/journal/*.log.ndjson` for every exchange call and its response.

## What this does not do

Single symbol, single position, REST polling (no WebSocket), no order-book awareness, no partial fills, no funding-rate handling for perpetuals. The HTTP API (`npm run start`, loopback only) has no authentication — it is a local tool.
