# Cross-reference: poly_bot_livewinner2case.py vs this repo vs reference repos

Date: 2026-06-10. Subject: the uploaded live bot `poly_bot_livewinner2case.py`
("Stripped-Core Bot — LIVE", 2,358 lines), cross-referenced against the arb
trader in this repo and the reference repos studied in
[reference-study.md](reference-study.md). The previous code work was searched
for in the connected Google Drive (`Documents/Claude/Polymarket bots`): **no
such folders exist in that Drive** — the lineage of this bot (diagnostic
versions, other "case" variants) is presumably on local disk and was not
available for this analysis.

## 1. Security finding — act before anything else

The uploaded file hardcodes a **live Polygon private key and funder address**
(lines 50–51; redacted here, identified in chat). That key controls the
Polymarket account this bot trades. It must be treated as **compromised**:
it exists in plaintext in at least one file that has been copied between
machines/services. Recommended sequence:

1. Create a fresh wallet; transfer USDC and open positions out of the funder.
2. Stop using the old key anywhere; delete its CLOB API creds (they are
   derived from the key and equally burned).
3. Going forward, load `PK` from env vars only — this repo's `.env` pattern
   and the handoff constraint both already require that.

This document and repo deliberately do not contain the key. The uploaded file
must never be committed as-is.

## 2. What the bot is

Not an arbitrage bot. It trades Polymarket's **5-minute BTC up/down markets**
(Gamma slugs `btc-updown-5m-<timestamp>`) with a directional
market-making/momentum hybrid. Core decision ("3 questions"): book imbalance
positive for the side, BTC spot direction (Binance trade stream) agrees or
neutral, and inventory not maxed — then post a passive bid at ask−1¢ with a
~2.5s TTL, with a 0.47–0.53 dead zone excluded.

Layered on top of that core: a price-regime table (imbalance bar loosens as
price confirms away from 0.50), inventory-skew penalties, a structure
classifier (CHOP/LEAN/STRONG/FLIP with hysteresis), BTC turn detection and
phase budgets (back-loaded so early phases can't spend the clip), flip
catch-up and late-wave budgets, selective spread-crossing takers, an
expensive-tail cap, and a **cheap-side "farm"** that accumulates the light
side below ~0.45 to complete YES+NO pairs.

The farm is the arb-adjacent part: completed pairs redeem for $1, so farm
fills below the heavy side's average build the same riskless pairs this
repo's `pair` strategy buys atomically. End-of-window P&L is reported as
`pairs × (1 − pair cost)` plus two directional scenarios for the unpaired
remainder — i.e. the bot knowingly carries directional risk that this repo's
arb trader never takes.

## 3. Client dependency — the bot cannot trade today

It imports `py_clob_client` (`init_client()`, order posting, balance polls).
That client was archived in May 2026 and its README states it is **no longer
functional** — this is precisely the bot the migration handoff predicted.
Call-site map to the unified Python SDK (`polymarket-client`, see
[reference-study.md](reference-study.md) for signatures):

| Bot call site (py_clob_client) | py-sdk equivalent | Notes |
| --- | --- | --- |
| `ClobClient(host, key=PK, chain_id=137, signature_type=1, funder=…)` | `SecureClient.create(private_key=…, wallet=funder)` | `signature_type` gone — wallet type auto-classified; host/chain implied by environment |
| `create_or_derive_api_creds()` + `set_api_creds()` (and the per-window re-derive) | automatic inside `SecureClient.create` | drop entirely |
| `create_order(OrderArgs(price, size, BUY, token_id))` + `post_order(signed, GTC)` | `place_limit_order(token_id, price, size, side="BUY")` | one call; tick size & negRisk auto-fetched |
| `client.cancel(order_id)` / manual TTL loop | SecureClient cancel methods; GTD `expiration` can replace the homegrown TTL-cancel thread | server-side expiry > client-side cancel race |
| `get_balance_allowance(CONDITIONAL)` polling at 0.5s to infer fills | `UserSpec` websocket → `UserTradeEvent` | exact fills with real prices — see §4, this also fixes the cost-basis bug |
| raw `wss://ws-subscriptions-clob.polymarket.com/ws/market` handling | `MarketSpec(token_ids=[…])` subscription → book/price events | SDK validates and maintains book state |
| Gamma slug probing via `requests` | unchanged (raw REST) or SDK market lookup | works either way |

## 4. Code review of the live bot (read-only)

Worth keeping — the domain logic is genuinely sophisticated:
- The structure classifier + hysteresis, phase-budget allocation
  (back-loading capacity into the late window), and burst/TTL pacing are a
  real edge-management framework, far beyond poly-market-maker's bands.
- Dead-zone exclusion, price-regime imbalance bars, and the farm's
  ratio/ceiling caps are coherent, tested-feeling risk shaping.
- The cutoff that cancels everything with 55s left (and re-cancels after
  0.5s to catch in-flight posts) handles a real race correctly.

Defects to fix in any revival, beyond the dead client:

1. **Fill detection is inferential.** Balance polls every 0.5s, attributing
   any increase to "a fill at the average of recently posted prices"
   (`OrderManager._poll_balances`). Cost basis — and therefore the P&L the
   bot reports — is an estimate. The `raw/1_000_000 if raw > 100_000`
   decimals heuristic will misread balances near 100k units. `UserTradeEvent`
   gives exact per-fill price/size.
2. **Silent failure everywhere.** Dozens of bare `except: pass` blocks,
   including around balance reads, cancels, and WS parsing. A live bot
   should at minimum count these.
3. **Recursive reconnects.** Both `BinanceFeed._run` and
   `BookEngine._run_ws` reconnect by calling themselves from `on_close`,
   stacking `run_forever` frames over a long session; should be a loop.
4. **No kill switch, no daily loss cap, no spend cap in USD.** Caps are
   share-count based (`MAX_INV_SIDE/TOTAL`); a string of bad windows has no
   circuit breaker. Compare polybot's `hft.risk.kill-switch`, bankroll EMA
   circuit breaker, and live-ACK guard — and this repo's `KILL` file switch.
5. **Hardcoded credentials** (§1) and hardcoded aggressive tunables from an
   "AGGRESSION PASS"; comments reference matching a target trader
   ("vidarx"), i.e. replication tuning — polybot's replication-scoring
   tooling is the principled version of that calibration loop.

## 5. Cross-reference matrix

| | uploaded live bot | this repo (`src/`) | poly-market-maker | polybot |
| --- | --- | --- | --- | --- |
| Strategy | directional MM + pair farm on 5m BTC up/down | riskless baskets (pair, cross-strike, neg-risk, mint-sell) | bands/AMM quoting | complete-set arb ("gabagool") |
| Client | py_clob_client (**dead**) | clob-client-v2 (**alive**) | py-clob-client (dead) | custom Java (alive) |
| Risk at fill | directional (unpaired inventory) | none (locked at fill) | inventory-bounded | strategy-dependent |
| Fill truth | inferred from balance polls | FOK response / paper plan | order sync loop | order status polling + ClickHouse |
| Paper mode | `--dry` (assumes every order fills instantly — optimistic) | dry-run + depth-sized paper ledger | none | PAPER mode + probabilistic fill sim |
| Kill switch | none | env + `KILL` file | none | flag + HTTP ACK + bankroll breaker |
| Book feed | websocket (best-in-class here) | REST polling | REST polling | websocket |

**Where each should learn from the others:**
- **This repo from the bot:** the websocket `BookEngine` (sub-second book
  state vs our 15s polling) is the single biggest latency upgrade available
  for the arb scanner; its pacing primitives (TTL, burst limiter) matter if
  we ever rest maker orders.
- **The bot from this repo:** env-var keys, kill switch, depth-sized paper
  fills (its `--dry` mode books instant fills at bid price — flattering),
  and an append-only ledger instead of `live_results.json` written only on
  Ctrl-C.
- **Both from polybot:** explicit live-trading acknowledgment and a bankroll
  circuit breaker.

## 6. Recommended path

1. Rotate the key (§1). Nothing else matters until that's done.
2. Treat the uploaded bot as the strategy spec for a port, not runnable
   code: its client is dead. Port to py-sdk using the §3 table (or
   re-implement inside this TypeScript codebase as a second strategy
   service; the book/structure logic translates directly).
3. Carry over this repo's safety rails (env keys, kill switch, paper ledger,
   USD budgets) into the port before any live run.
4. If the other "case" variants and diagnostics from the local
   `Documents/Claude/Polymarket bots` folder matter for the port, they need
   to be uploaded or synced to the connected Drive — they are not reachable
   from this environment.
