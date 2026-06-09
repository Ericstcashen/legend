# Polymarket reference repo study

Date: 2026-06-09. Companion to [migration-audit.md](migration-audit.md).
Repos cloned read-only into `polymarket-repos/` (gitignored). Nothing here was
executed against live endpoints; no orders were placed anywhere in this work.

## py-sdk (`Polymarket/py-sdk`) — canonical Python patterns

- Package `polymarket-client` (import `polymarket`), version `0.1.0b5` —
  **beta**, Python ≥ 3.11, MIT. No examples directory; quickstart lives in the
  README, design notes in `docs/sdk-direction.md`. There is **no
  py-clob-client migration guide** — it's a clean break.
- Clients: `PublicClient` / `SecureClient` (plus `Async*` variants).
  `SecureClient.create(private_key, wallet=None, credentials=None, ...)`
  auto-derives API creds when `credentials` is omitted and **auto-classifies
  the wallet type** (EOA / POLY_PROXY / GNOSIS_SAFE / DEPOSIT_WALLET) — the
  old `signature_type` + `funder` parameters are gone, same design as ts-sdk
  (`src/polymarket/clients/secure.py:209`, `_internal/wallet.py`).
- Orders: high-level `place_limit_order()` (GTC/GTD, `post_only`) and
  `place_market_order()` overloaded by side — BUY takes USDC `amount` +
  optional `max_spend`, SELL takes `shares`; FAK default, FOK available.
  Tick size, negRisk, and builder fees are **auto-fetched** during
  preparation (`clients/secure.py:1490-1689`).
- Market data: `get_order_book(s)`, `get_spread(s)`,
  `get_last_trade_price(s)`, `estimate_market_price(...)`
  (`clients/public.py:944-1038`).
- Websockets (async clients only): `subscribe(spec)` with `MarketSpec`
  (book/price/last-trade events, optional best-bid-ask + lifecycle),
  `UserSpec` (order/trade events), plus sports/comments/crypto/equity feeds
  (`src/polymarket/streams/`).

**Takeaway for our bot:** the legacy `py_clob_client` → `py-sdk` mapping in
the handoff is moot for this repo (no Python code, see the audit), but the
SDK's shape mirrors ts-sdk one-to-one, so the audit's call-site mapping
transfers directly if a Python port is ever wanted.

## agents (`Polymarket/agents`) — official LLM-agent scaffolding

- Structure: Gamma connector (`agents/polymarket/gamma.py`), CLOB wrapper
  (`agents/polymarket/polymarket.py`), news/Tavily/Chroma RAG connectors
  (`agents/connectors/`), LLM trade executor
  (`agents/application/executor.py`), CLI.
- **Critical:** it still depends on `py_clob_client==0.17.5` and
  `py_order_utils` (`requirements.txt:115`,
  `agents/polymarket/polymarket.py:17-29`) — i.e. Polymarket's own agent
  framework currently sits on the archived, non-functional client. Treat the
  trading half as dead code until upstream migrates it to py-sdk.
- Reusable for a market-scanning layer: the Gamma connector and the
  news/RAG/search connectors (no CLOB dependency). Avoid: the executor's
  discretionary LLM trade decisions (out of scope per the handoff) and
  anything importing `py_clob_client`.

## poly-market-maker (`Polymarket/poly-market-maker`) — official MM reference

- **Depends on the archived `py-clob-client>=0.13.3`**
  (`requirements.txt`); per the archive notice the client is no longer
  functional, so this repo is a historical reference, not runnable code.
- Strategy structure (`poly_market_maker/strategies/`): two strategies behind
  one sync-loop manager (`strategy.py`). **Bands** places orders in margin
  bands around the CLOB midpoint (`minMargin/avgMargin/maxMargin` ×
  `minAmount/avgAmount/maxAmount`, `config/bands.json`), cancelling when a
  band exceeds `maxAmount` and replenishing below `minAmount`, sells before
  buys to reduce capital lock-up. **AMM** emulates concentrated liquidity
  over `p_min/p_max` with `spread`/`delta` discretization and a
  `max_collateral` cap. Lifecycle every sync interval (default 30s): fetch
  midpoint → compute expected orders → diff against open orders → cancel
  then place. SIGTERM cancels all orders on shutdown.
- Risk controls: free-balance accounting in `orderbook.py`
  (balance − collateral locked by open BUYs − tokens locked by SELLs),
  zero/invalid-balance refusal, capital caps. **No kill switch, no position
  limits, no circuit breaker.**
- Comparison to our quoting-free arb bot: the cancel-before-place sync
  discipline and free-balance accounting are the patterns worth borrowing if
  we ever rest limit orders instead of taking with FOK.

## polybot (`ent0n29/polybot`) — community infra

- Java 21/Spring Boot microservices with a **custom in-house Polymarket
  client** (`polybot-core/.../clob/PolymarketClobClient.java`) — no archived
  dependencies; would run today. Services: strategy (a "gabagool"
  complete-set arb — same family as our pair arb), executor, ingestor,
  analytics, orchestrator, with Kafka + ClickHouse + Grafana/Prometheus.
- **Paper/live split (the part worth copying):** a single `hft.mode`
  enum (`PAPER`/`LIVE`) checked inside the trading service
  (`PolymarketTradingService.java:76-83`) — PAPER fabricates an order
  response (`paper-<uuid>`) and never touches the venue, while a simulator
  fills paper orders probabilistically (`application-develop.yaml`:
  `sim.maker-fill-probability-per-poll`, fill fractions). Two extra layers we
  lack: a **kill switch** (`hft.risk.kill-switch` blocks all placement) and a
  **live-trading guard** (`LiveTradingGuardFilter.java` returns HTTP 428
  unless the caller sends `X-HFT-LIVE-ACK: true`), plus a bankroll
  circuit-breaker (EMA equity below threshold halts new orders).
- ClickHouse ingestion: Kafka → `analytics_events` (MergeTree) →
  materialized canonical tables — `user_trades` (per-fill prints incl.
  tx hash) and `clob_tob` (top-of-book + depth/imbalance snapshots keyed to
  trades), with enriched views adding execution classification and
  seconds-to-expiry (`analytics-service/clickhouse/init/`).
- Replication scoring (`research/replication_score*.py`): distribution-level
  comparison of the bot's fills/decision stream against a target trader — L1
  distance over market mix, outcome mix, execution type, timing buckets,
  sizing stats; the order-stream variant compares cadence/replace/top-up
  behavior. It's copy-trading calibration tooling — not relevant to our
  strategy, but the metric structure is a good template for comparing
  paper-mode behavior to live.
- Flags per the handoff: README announces **AWARE**, a forthcoming product
  layer (trader intelligence, fund mirroring) built on polybot — disclosure
  of a future product, but no referral links, paid gating, or token shilling
  in the code. No withdrawal logic anywhere (settlement only merges complete
  sets, off by default, dry-run available). Credentials are env-var based.
  Treat as read-only reference, as instructed — **do not deploy as-is.**

## Adoption candidates for this bot

Concrete, small upgrades inspired by the study (not implemented here):

1. **Kill switch env flag** checked in `LiveExecutor` before any order
   (polybot's `hft.risk.kill-switch`).
2. **Paper-fill simulator** so dry-run produces a P&L stream instead of just
   logs (polybot's executor sim).
3. **Free-balance pre-check** before firing legs, from poly-market-maker's
   locked-collateral accounting (our bot currently trusts FOK rejection).

## Awesome-Polymarket-Tools (`harish-garg/Awesome-Polymarket-Tools`)

Index-only, 121★, CC0. Used for discovery; flags worth recording:

- **Stale SDK guidance:** still lists `py-clob-client` and
  `@polymarket/clob-client` as the official clients with no archive warning,
  and does not list `py-sdk`/`ts-sdk` at all.
- **Placeholder/SEO entries:** the "Trading & Execution" and "Copy Trading"
  sections link to `github.com/username/...` — literally nonexistent
  placeholder URLs. Do not trust those sections.
- **Paid products / unaudited execution:** the whale trackers (PolyTrack,
  Polywhaler, etc.) are commercial products, and the Telegram copy-trading
  bots (Polycule, PolyFocus, Polycool, ...) are custodial, closed-source
  execution — exactly the category the handoff said to treat as
  marketing/read-only. Nothing from these was used.
