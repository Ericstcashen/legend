# Polymarket client migration audit

Date: 2026-06-09. Scope: this repo's arb bot (`src/`) against the May 2026
archival of Polymarket's legacy clients. Reference repos cloned via
[`clone-polymarket-repos.sh`](../clone-polymarket-repos.sh) into
`polymarket-repos/` (gitignored).

## Verdict

**No forced migration is required.** This bot has zero dependency on either
archived client. Its only Polymarket dependency is
`@polymarket/clob-client-v2@1.0.6`, which is **not** archived: upstream's last
commit is 2026-06-05 and its README merely *recommends* the new unified
`ts-sdk` "for new projects".

| Client | Status (June 2026) | Replacement |
| --- | --- | --- |
| `Polymarket/py-clob-client` (Python) | Archived; README: "no longer functional" | `Polymarket/py-sdk` |
| `Polymarket/clob-client` (TS, v1) | Archived; README: "no longer functional" | `Polymarket/ts-sdk` |
| `Polymarket/clob-client-v2` (TS) — **what this bot uses** | Active, maintained | ts-sdk recommended for *new* projects only |
| `Polymarket/ts-sdk` (`@polymarket/client`) | **Beta** (`0.1.0-beta.4`), requires Node ≥ 24 | — |
| `Polymarket/py-sdk` | New unified Python SDK | — |

## Dependency scan

`grep` over the repo (excluding `node_modules/`, `polymarket-repos/`) for
`py_clob_client`, `py-clob-client`, `@polymarket/clob-client` (non-v2), and
Python Polymarket imports: **zero matches**. There are no Python components.

All client usage is `@polymarket/clob-client-v2`, confined to three files:

| File | Imports |
| --- | --- |
| `src/index.ts` | `ClobClient` (constructor), `Chain`, `ApiKeyCreds`, `createOrDeriveApiKey()` |
| `src/books.ts` | `getOrderBooks()`, `getFeeRateBps()`, `OrderBookSummary` type |
| `src/executor.ts` | `createAndPostMarketOrder()`, `OrderType`, `Side` |

Key handling already complies with the constraints: private key and CLOB creds
come from env vars only (`.env` is gitignored), live trading is opt-in via
`LIVE=1`, and the default path is dry-run with no order placement.

## Call-site → ts-sdk mapping

If/when we migrate to `@polymarket/client` (ts-sdk), every touchpoint maps as
follows. Verified against `polymarket-repos/ts-sdk/packages/client/src`.

### 1. Read-only client — `src/index.ts:20`

```ts
// today (clob-client-v2)
const client = new ClobClient({ host: cfg.clobApiUrl, chain: chainId });

// ts-sdk
import { createPublicClient } from "@polymarket/client";
const client = createPublicClient(); // environment defaults to production; no host/chain
```

### 2. Authenticated client + creds derivation — `src/index.ts:24-41`

```ts
// today: viem wallet + optional ApiKeyCreds + manual createOrDeriveApiKey()
let client = new ClobClient({ host, chain: chainId, signer, creds });
if (!creds) creds = await client.createOrDeriveApiKey();

// ts-sdk: one call; L2 auth handled internally (beginAuthentication/authenticateWith)
import { createSecureClient } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
const client = await createSecureClient({
  wallet: process.env.POLYMARKET_DEPOSIT_WALLET!, // funder address — NEW required input
  signer: privateKey(process.env.PK!),
  // credentials: { key, secret, passphrase } — optional; derived if omitted
});
```

Breaking: ts-sdk requires the **funder/deposit wallet address** up front and
auto-classifies the wallet type (EOA / Poly proxy / Gnosis Safe / deposit
wallet → `SignatureType` is derived via CREATE2 address checks in
`packages/client/src/wallet.ts`). The old explicit `signatureType` and
`funder` knobs are gone. We would need one new env var
(`POLYMARKET_DEPOSIT_WALLET`); for a plain EOA it equals the signer address.

### 3. Batched order books — `src/books.ts:47`

```ts
// today
const books = await client.getOrderBooks(batch.map((w) => ({ token_id: w.tokenId })));

// ts-sdk
const books = await client.fetchOrderBooks(batch.map((w) => ({ tokenId: w.tokenId })));
```

Response fields are camelCased by a zod transform
(`packages/bindings/src/clob/order-book.ts`): `asset_id → tokenId`,
`tick_size → tickSize`, `neg_risk → negRisk`, `min_order_size → minOrderSize`.
`src/books.ts` keys results by `book.asset_id` — must become `book.tokenId`.

### 4. Fee rate — `src/books.ts:21` (`getFeeRateBps`)

No 1:1 public equivalent. ts-sdk resolves platform fees internally from market
info as `{ rate, exponent }` (`actions/orders/market.ts:fetchMarketFeeInfo`)
and exposes fee-aware sizing on BUY market orders via `maxSpend`. Migration
options: (a) drop our explicit fee adjustment and pass
`maxSpend = plannedCost` so the SDK bounds all-in spend, or (b) fetch market
info per condition and keep `feeAdjustAsks`. **Note:** our linear
`bps × min(p, 1−p)` model must be re-validated against the SDK's
`{rate, exponent}` formula at migration time.

### 5. FOK execution with price cap — `src/executor.ts:38-52`

```ts
// today: price cap is a first-class market-order arg
await client.createAndPostMarketOrder(
  { tokenID, amount, price: capPrice, side: Side.BUY, orderType: OrderType.FOK },
  { tickSize, negRisk },
  OrderType.FOK,
);

// ts-sdk: one-shot place; tickSize/negRisk auto-resolved; NO price-cap parameter
import { OrderSide, OrderType } from "@polymarket/client";
await client.placeMarketOrder({
  tokenId,
  side: OrderSide.BUY,
  amount: legCost,        // pre-fee USD notional
  maxSpend: legCost,      // all-in cap including fees
  orderType: OrderType.FOK,
});
```

Breaking differences that matter to this bot:

- **No price cap on market orders.** Slippage control becomes
  `estimateMarketPrice()` pre-check + FOK semantics + `maxSpend`. Limit orders
  do carry `price` but only support GTC/GTD (no FOK), so a "marketable limit
  FOK" replacement does not exist.
- **`amount` is pre-fee**; fees are paid on top unless `maxSpend` is set.
  Today's `amount` is our all-in planned cost — map it to `maxSpend`.
- **`placeMarketOrder` includes automatic allowance recovery**
  (`actions/orders/trade.ts`: `approveOrderAndRetry`): on an allowance
  failure it can send on-chain approval transactions automatically. That is
  new behavior for a live bot and must be understood before enabling live mode
  under ts-sdk.
- Enum/type renames: `Side → OrderSide`, `tokenID → tokenId`,
  `OrderBookSummary → OrderBook`, `ApiKeyCreds → credentials` option.

### 6. Market discovery (`src/gamma.ts`, hand-rolled)

Not a client call site today (raw `fetch` against Gamma), but ts-sdk would
subsume it: `client.listEvents({ tagSlug: "bitcoin", closed: false })` and
`client.listMarkets({ ... })` (typed, paginated via `firstPage()` /
async iteration). A migration should replace `src/gamma.ts` with these.

### Websockets

The bot does not use websocket feeds. For reference: clob-client-v2 only
ships raw `ws` examples, while ts-sdk has first-class typed subscriptions
(`packages/client/src/decorators/subscriptions.ts`) — an argument *for*
ts-sdk when we add streaming book updates.

## Why no migration branch was shipped now

1. The premise of forced migration is false for this bot — its client is
   current and maintained, while the migration target is explicitly **beta**
   with an unstable public API ("will use feedback during the beta period to
   refine the developer experience").
2. ts-sdk's engines require **Node ≥ 24**; this project (and the audit
   sandbox) target Node ≥ 20.10. A port is also a runtime upgrade.
3. Polymarket's APIs are Cloudflare-blocked from this sandbox, so a ported
   branch could not be validated against live order books even in dry-run —
   it would be untested code presented as a migration.

**Recommended triggers to revisit:** ts-sdk reaches a stable 1.0; or
clob-client-v2's README warning escalates from "recommend for new projects"
to a deprecation/archival notice; or we need typed websocket feeds. The
mapping above is complete — the port touches only `src/index.ts`,
`src/books.ts`, `src/executor.ts`, and optionally `src/gamma.ts`, and is
roughly a day of work plus live dry-run validation.
