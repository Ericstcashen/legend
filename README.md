# polymarket-btc-arb

Arbitrage scanner and trader for Polymarket **bitcoin** markets, built on
[`@polymarket/clob-client-v2`](https://github.com/Ericstcashen/clob-client-v2).

It hunts for baskets of outcome tokens whose combined ask cost is below their
guaranteed redemption value at resolution, sizes them by walking the order
books jointly, and (optionally) fires fill-or-kill buys for every leg.

## Strategies

All three are *buy-only* baskets — no shorting, no inventory needed, and each
basket's payoff at resolution is deterministic:

1. **Pair arb** — in a single binary market, if `ask(YES) + ask(NO) < $1`,
   buy both. The pair always redeems for exactly $1.
2. **Cross-strike arb** — bitcoin threshold markets are grouped into
   *families* that share the same question template, direction, and end date
   and differ only by strike (e.g. "Will Bitcoin be above $100,000 / $110,000
   on June 13?"). For strikes `K1 < K2` in an "up" family,
   `YES(>K1) + NO(>K2)` redeems for **at least** $1 (and $2 if BTC lands
   between the strikes), so any combined ask under $1 is risk-free.
   "Dip to" / "below" families are handled with the inequality flipped.
3. **Negative-risk arb** — for mutually exclusive multi-outcome events
   (e.g. "What will Bitcoin's price be on …?"), one set of **all YES** redeems
   for exactly $1, and one set of **all NO** redeems for $(n−1). Either basket
   is bought when it trades below its redemption value.
4. **Mint-and-sell** — the inverse signal: when net YES+NO *bids* exceed $1,
   splitting $1 of USDC into a complete YES+NO set (CTF `splitPosition`) and
   selling both is an immediate profit with no capital lock. By default these
   are reported as `MANUAL`; set `MINT_SELL_LIVE=1` to arm the dedicated
   on-chain executor (`src/mintSell.ts`) that splits collateral and sells both
   legs FOK. The split is an irreversible transfer — **validate against a
   testnet/fork before enabling on mainnet** (the calldata encoding is
   unit-tested in `tests/ctf.test.ts`, but the broadcast path can't be
   exercised offline).

Sizing walks every leg's ask levels simultaneously and stops at the depth
where the *marginal* cost of one more share-set crosses
`redemption × (1 − MIN_EDGE)`, then caps by `MAX_USD_PER_TRADE`. Per-token
taker fees (`fee = bps × min(p, 1−p)`) are folded into prices before any
comparison, so the configured edge is net of fees.

### Book feed: REST vs websocket

Arbs are fleeting, so latency is the difference between capturing an edge and
watching someone else take it. Two feed modes:

- **REST polling** (default): each scan fetches books over HTTP. Simple, but
  an arb that appears mid-interval isn't seen until the next scan.
- **Websocket** (`USE_WEBSOCKET=1`): `src/wsBook.ts` keeps every tracked
  token's book in memory from the CLOB market channel's `book` snapshots and
  `price_change` deltas, so the scanner reads current state with zero
  per-scan network latency and sees a dislocation the instant the book moves.
  Stale books (no update within `BOOK_STALENESS_MS`) are excluded. In this
  mode scanning is also **event-driven**: a book update triggers a scan
  immediately (coalesced within ~50 ms), instead of waiting for the next
  `SCAN_INTERVAL_MS` tick — so an arb is contested the moment it appears, not
  up to an interval later. The interval remains as a heartbeat fallback.

## Quick start

```bash
npm install
cp .env.example .env

# one dry-run scan (no keys needed — public endpoints only)
npm run scan

# continuous dry-run scanning
npm start
```

Dry-run mode prints every qualifying opportunity with per-leg sizes, price
caps, cost, and guaranteed profit, but never sends an order. Each qualifying
basket is also booked to a **paper ledger** (`data/paper-trades.jsonl`,
configurable via `PAPER_LEDGER`): fills are sized from live depth, profits are
locked at fill time, and the running summary (`paper P&L: N fills, $X
deployed, $Y locked profit`) is printed every scan and survives restarts.
A per-opportunity cooldown (`COOLDOWN_MS`, default 10 min) stops a standing
arb from being re-counted — or re-fired in live mode — every scan.

## Measuring profitability offline

Polymarket's live endpoints aren't always reachable (and you shouldn't trade
real money to find out whether the strategies work). `npm run simulate` drives
the **real** scanner, strategies, risk checks, and paper ledger against a
seeded synthetic market generator (`src/sim.ts`) that injects riskless
dislocations — pair arbs, cross-strike inversions, and overpriced books — so
the captured profit is measurable end-to-end with no network:

```bash
npm run simulate -- --rounds 300 --seed 7        # 0 bps fees
npm run simulate -- --rounds 300 --seed 7 --fee 60   # net of 60 bps taker fees
```

It prints injected-vs-captured counts and the ledger's locked profit / ROI.
Because every injected basket is riskless by construction, the reported profit
is a true lower bound on what the strategies extract from those books, and the
run exits non-zero if any booked basket fails the riskless invariant. The same
pipeline is asserted in `tests/simulation.test.ts` (determinism, edge clears,
cost < guaranteed value, all injected pair arbs captured, positive net-of-fee
profit), so strategy changes that erode profitability fail CI.

## Backtesting on real recorded books

Synthetic simulation proves the strategy logic; backtesting proves it on *real*
market conditions. Set `RECORD_BOOKS=data/books.jsonl` and every scan's
fee-adjusted books are appended to a JSONL file (`src/record.ts`). Run the
scanner connected to live endpoints for a while to accumulate a dataset, then
replay it through the exact strategy/allocator/cooldown pipeline:

```bash
RECORD_BOOKS=data/books.jsonl npm start      # capture real books while scanning
npm run backtest -- --file data/books.jsonl --budget 500
```

The backtest report (`src/backtest.ts`) measures booked baskets, capital
deployed, realized profit, ROI, and a per-strategy breakdown across the
recording — measured performance on the actual books the market presented,
with the same cooldown and daily-budget discipline the live loop uses.

## Going live

> **Use at your own risk.** This trades real USDC. Start with small limits.

### Deployment runbook

Run from a machine that can reach Polymarket's endpoints (the public API is
Cloudflare-protected and may block datacenter/sandbox IPs):

1. `npm install && cp .env.example .env`
2. **Calibrate first (no risk):** `RECORD_BOOKS=data/books.jsonl npm start`
   for a while, then `npm run backtest -- --file data/books.jsonl` to see the
   ROI the strategies would have captured on the real books you just recorded.
3. Fund a Polygon wallet with USDC and approve Polymarket's exchange
   allowances (one manual UI trade sets them).
4. Set `PK` and `LIVE=1`, keep limits small (`MAX_USD_PER_TRADE`,
   `MAX_DAILY_USD`).
5. **`npm run preflight`** — validates config, key, and endpoint reachability
   and prints a GO / NO-GO. Don't start live until it says GO.
6. `USE_WEBSOCKET=1 LIVE=1 npm start` — lowest-latency, event-driven mode.
   Watch the paper-then-real ledger accumulate; `touch KILL` halts instantly.

1. Fund a Polygon wallet with USDC and approve Polymarket's exchange
   allowances (see the `examples/account/approveAllowances.ts` script in
   clob-client-v2, or place one manual trade through the UI which sets them).
2. Set `PK` in `.env` and `LIVE=1`. CLOB L2 API credentials are derived from
   the wallet automatically on startup if not provided.
3. Tune `MIN_EDGE`, `MIN_PROFIT_USD`, `MAX_USD_PER_TRADE`, `MAX_DAILY_USD`.
4. `npm start`

To halt live order placement instantly without stopping the scanner, run
`touch KILL` in the working directory (or set `KILL_SWITCH=1` before start);
remove the file to resume.

**Capital rationing.** Each scan funds non-overlapping baskets by ROI within
the remaining daily budget (`src/allocator.ts`). De-duplicating overlapping
legs matters: two baskets sharing a token would double-count the same book
depth that a single fill consumes. (ROI-first vs profit-first ordering is
within noise when baskets are large relative to the budget — see the
simulator's capital-rationing report — so the ordering is a sensible default,
not a profit lever in itself.)

**Bankroll circuit breaker.** A partial (unhedged) fill books its at-risk
spend as a realized loss to an EMA-smoothed equity tracker; if equity falls
`MAX_DRAWDOWN` below its peak, live trading halts until it recovers
(`src/allocator.ts` `Bankroll`), protecting capital during a bad run.

Execution uses sequential **FOK market buys**, one per leg, each capped at the
worst book level the plan touched. FOK fills entirely at-or-better or not at
all, so a book move mid-basket leaves at most the earlier legs filled — the
trader logs an **UNHEDGED** warning with the filled size and stops; completing
or unwinding that position is a manual decision.

## Configuration

Everything is set via `.env` — see [`.env.example`](.env.example) for the full
list with defaults. The important dials:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIN_EDGE` | `0.01` | Required profit per $1 redeemed, net of fees |
| `MIN_PROFIT_USD` | `0.25` | Skip opportunities smaller than this in total |
| `MAX_USD_PER_TRADE` | `100` | Cost cap per basket |
| `MAX_DAILY_USD` | `500` | Spend cap per UTC day |
| `SCAN_INTERVAL_MS` | `15000` | Delay between scans |
| `TAG_SLUGS` / `KEYWORDS` | `bitcoin` / `bitcoin,btc` | Market discovery filters |

## Layout

```
src/
  index.ts       main loop: discover → fetch books → find arbs → risk check → execute
  gamma.ts       market discovery via the Gamma API (tag slugs + keyword sweep)
  strikes.ts     strike parsing and family grouping for cross-strike arbs
  books.ts       batched orderbook fetching, fee adjustment
  arbMath.ts     joint book-walking and basket planning (pure functions)
  strategies.ts  the opportunity finders (pair, cross-strike, neg-risk, mint-sell)
  books.ts       REST order-book fetching (batched, concurrent, fee-adjusted)
  wsBook.ts      live websocket order-book state + fee-adjusted leg snapshots
  executor.ts    dry-run logger / live FOK execution
  ctf.ts         Conditional Tokens split/merge calldata (mint-and-sell)
  mintSell.ts    gated on-chain mint-and-sell executor
  allocator.ts   ROI capital rationing + bankroll circuit breaker
  risk.ts        per-trade and daily budget enforcement, opportunity cooldown
  paper.ts       append-only paper P&L ledger
  sim.ts         seeded synthetic market generator (offline)
  simulate.ts    offline profitability harness (npm run simulate)
  record.ts      tees live books to JSONL for backtesting
  backtest.ts    replays recordings through the pipeline (npm run backtest)
tests/           unit tests for math, parsing, book state, simulation, backtest
```

## Caveats

- Real cross-venue competition makes sub-1% intra-book arbs rare and
  short-lived; expect most scans to find nothing. The cross-strike and
  neg-risk scans are where stale quotes actually show up.
- Capital is locked until resolution: the edge is realized at market
  resolution, not at fill time. Prefer near-dated markets.
- Negative-risk events assume *exactly one* outcome resolves YES. Polymarket
  can add outcomes to open neg-risk events; the all-NO basket value can change
  if you hold through an outcome addition.
- The strike parser only trades families it can match exactly (same template,
  direction, end date). Anything ambiguous is ignored rather than guessed.
