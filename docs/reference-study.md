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

*(see findings below — strategy structure, risk controls, client dependency)*

## polybot (`ent0n29/polybot`) — community infra

*(see findings below — paper/live split, ClickHouse ingestion, replication
scoring, safety flags)*

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
