---
name: arb-safe-run
description: Safely run, calibrate, and go live with this Polymarket BTC arbitrage bot. Read BEFORE running the scanner/trader or changing anything that can place an order or move funds. Use when the user says "run the bot", "scan", "go live", "start trading", "simulate", "backtest", "preflight", "is it safe to run live", or touches LIVE / MINT_SELL_LIVE / the KILL switch / trade limits. Covers the dry-run → simulate → backtest → preflight → live escalation ladder and every money-touching guardrail.
---

# Running the arb bot safely

This project (`polymarket-btc-arb`) places **real fill-or-kill USDC orders** and can do
**irreversible on-chain CTF splits**. Money is lost by skipping a rung of the ladder below,
not by going slowly. Default to the lowest rung that answers the question at hand.

## The escalation ladder — never skip a rung to reach live

| Rung | Command | Risk | What it proves |
| --- | --- | --- | --- |
| 1. Dry scan | `npm run scan` | none | one pass finds arbs, logs sizes/cost/profit, sends **no** order |
| 2. Dry loop | `npm start` | none | continuous scanning + paper ledger (`data/paper-trades.jsonl`) |
| 3. Simulate | `npm run simulate -- --rounds 300 --seed 7` | none, offline | real strategy/risk/ledger vs seeded synthetic books; run with `--fee 60` too |
| 4. Backtest | `RECORD_BOOKS=data/books.jsonl npm start` then `npm run backtest -- --file data/books.jsonl --budget 500` | none | measured ROI on **real** recorded books |
| 5. Preflight | `npm run preflight` | none | validates config + key + endpoint reachability, prints **GO / NO-GO** |
| 6. Live | `USE_WEBSOCKET=1 LIVE=1 npm start` | **real money** | places FOK orders |

Rungs 1–5 need no private key and place no orders. Only rung 6 spends.

## Hard rules

1. **Never start rung 6 unless `npm run preflight` printed GO.** If it says NO-GO, fix the
   reported cause; do not override.
2. **Do not set `LIVE=1` on the user's behalf.** Going live is the user's explicit decision.
   Confirm the intent, the limits, and that the wallet is funded/approved first.
3. **`MINT_SELL_LIVE=1` is separate from and stricter than `LIVE`.** It arms
   `src/mintSell.ts`, whose CTF `splitPosition` is an **irreversible transfer**. Leave it
   `0` unless the user has validated the broadcast path on a testnet/fork. The calldata is
   unit-tested (`tests/ctf.test.ts`) but the broadcast path cannot be exercised offline.
4. **Keep limits small when going live.** `MAX_USD_PER_TRADE` and `MAX_DAILY_USD` are the
   blast radius. Do not raise them as a first move.
5. **Know the kill switch before starting live:** `touch KILL` in the working directory (or
   `KILL_SWITCH=1` before start) halts order placement instantly while the scanner keeps
   running; `rm KILL` resumes. Mention this whenever you start rung 6.
6. **An `UNHEDGED` warning is a manual decision, not an auto-fix.** A mid-basket book move
   can leave earlier FOK legs filled and the rest unfilled; the trader logs the filled size
   and stops. Do not write code to auto-unwind it — surface it to the user.

## Before every live change, verify offline first

Any change to strategy/allocator/risk/math must keep the suite green — the simulator asserts
riskless invariants and net-of-fee profit, so profitability regressions fail CI:

```bash
npm run typecheck && npm test
```

## Environment / sandbox note

Polymarket's public API is Cloudflare-protected and often blocks datacenter/sandbox IPs, so
rungs that hit live endpoints (2 with real fetch, 4 recording, 5, 6) may fail here even when
the code is correct. The **offline** rungs (1 with no network, 3 simulate, and `npm test`)
are the reliable way to validate logic in this environment. Run the live-endpoint rungs from
a machine that can reach Polymarket.

## Key dials (full list + defaults in `.env.example`, loaded by `src/config.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIVE` | `0` | places real orders when `1` |
| `MINT_SELL_LIVE` | `0` | arms irreversible on-chain mint-and-sell |
| `KILL_SWITCH` / `KILL` file | off | instantly halts order placement |
| `MIN_EDGE` | `0.01` | required profit per $1 redeemed, net of fees |
| `MIN_PROFIT_USD` | `0.25` | skip baskets smaller than this |
| `MAX_USD_PER_TRADE` | `100` | cost cap per basket |
| `MAX_DAILY_USD` | `500` | spend cap per UTC day |
| `MAX_DRAWDOWN` | `0.1` | drawdown that trips the bankroll circuit breaker |
| `USE_WEBSOCKET` | `0` | low-latency event-driven feed for live |

Full deployment runbook and rationale live in `README.md` ("Going live"); do not duplicate it
here — point the user there for wallet funding and allowance approval.
