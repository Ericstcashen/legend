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
4. **Mint-and-sell detection** — the inverse signal: when net YES+NO *bids*
   exceed $1, splitting $1 of USDC into a YES+NO pair (CTF split) and selling
   both is an immediate profit with no capital lock. The split is an on-chain
   step the executor does not automate, so these are reported as `MANUAL`
   opportunities with the available profit, never auto-traded.

Sizing walks every leg's ask levels simultaneously and stops at the depth
where the *marginal* cost of one more share-set crosses
`redemption × (1 − MIN_EDGE)`, then caps by `MAX_USD_PER_TRADE`. Per-token
taker fees (`fee = bps × min(p, 1−p)`) are folded into prices before any
comparison, so the configured edge is net of fees.

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

## Going live

> **Use at your own risk.** This trades real USDC. Start with small limits.

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
  strategies.ts  the three opportunity finders
  executor.ts    dry-run logger / live FOK execution
  risk.ts        per-trade and daily budget enforcement
tests/           unit tests for the math and parsing (npm test)
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
