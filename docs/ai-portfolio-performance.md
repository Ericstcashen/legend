# AI portfolio performance: the Claude-managed $50k experiment

Date: 2026-07-07. Scope: a factual write-up of the publicly-run experiment in
which a Claude agent manages a live ~$50,000 equity portfolio, its reported
performance versus the S&P 500, its disclosed holdings, and the caveats that
belong on any of these numbers.

> **This document is analysis, not advice, and not an instruction to trade.**
> Nothing here was traded from this repo. No orders were placed, no brokerage
> or money-movement tool was invoked, and no position in the user's own
> accounts was read or modified in producing it. The figures below are
> second-hand from public reporting and the experiment's own posts; treat them
> as claims to be verified, not settled fact.

## What the experiment is

"AI Finance Labs" — the team behind the **Pelosi Tracker** — seeded a Claude
agent with roughly **$50,000** and let it run a live U.S. equity portfolio with
**no human override on individual trades**. A sibling experiment does the same
with a Grok agent. Both are published in the open (the X accounts
`@theaiportfolios` and `@grkportfolio`) and are copy-tradeable through the
**Autopilot** marketplace, where users can connect a broker and mirror the
picks automatically.

The pipeline, as the operators describe it, is agentic end to end:

1. Score a broad universe (reported as the Russell 1000 / "AI scores the entire
   Russell 1000 on fundamentals, news, and analyst data").
2. Run internal **bull/bear debates** per candidate before sizing.
3. Build probability-weighted return models and select ~**15 holdings** under
   sector and single-name risk constraints.
4. **Rebalance once or twice weekly**, holding a cash reserve when it wants to
   de-risk (e.g. ahead of macro events).

## Reported performance

The headline this document was asked to record:

| Metric                         | Claude portfolio | S&P 500 |
| ------------------------------ | ---------------- | ------- |
| Return since inception (~Mar/Apr 2026, ~4 months) | **+14.16%** | **+10.33%** |
| Relative outperformance        | **≈ +3.8 pts**   | —       |

Public reporting over the same window is directionally consistent but **not
identical**, which is exactly what you would expect from figures snapshotted on
different days of a volatile, actively-rebalanced book:

- An early-April snapshot (two sessions in) had the book essentially flat
  (~$47,013 on a then ~$47,000 mark) and *trailing* an equal S&P investment —
  i.e. it did **not** beat the market out of the gate.
- A later three-month snapshot reported roughly **+12.6%** for the agent versus
  about **+9.75%** for SPY — a similar ~3-point edge to the +14.16% / +10.33%
  headline, measured a few weeks earlier.

**Takeaway:** the "beats the S&P by ~3–4 points" claim recurs across
independent snapshots, but the precise level (+12.6% vs +14.16%) is
date-sensitive. Any citation of a single number should be stamped with the date
it was read.

## Disclosed holdings and theses

The book is concentrated in **AI infrastructure, energy powering AI, and
software**, rounded out with financials, healthcare, and defense. Names that
have appeared publicly:

| Ticker | Name            | Reported role in the thesis |
| ------ | --------------- | --------------------------- |
| VST    | Vistra          | Largest-weight energy name; "power for AI datacenters" trade. Entered near ~10% weight. |
| AVGO   | Broadcom        | Core semiconductor position on the hyperscaler capex cycle; a May post cited ~+33% since the April 7 entry, at ~3.9% weight after trimming. |
| NOW    | ServiceNow      | Software / enterprise-AI position; rotated into while trimming Microsoft. |
| ZETA   | Zeta Global     | Smaller-cap AI-software / marketing-data pick, the "under-the-radar" style name. |

Plus undisclosed-here positions across financials, healthcare, and defense, and
a **cash reserve** the agent has used to step back ahead of macro catalysts
(the summary that prompted this doc cites caution ahead of July economic
events).

## How much weight to put on this

- **Sample size and horizon.** Four months and one regime (an AI/semiconductor
  and power-demand bull run) is far too short to separate skill from a factor
  bet that happened to be in favor. A book this concentrated in AI-infra + power
  is, in large part, a **levered long on one theme**; the benchmark-relative
  gain is as much a statement about that theme as about stock selection.
- **Benchmark choice.** "S&P 500" appears as both the index and SPY across
  reports, and price-return vs total-return (dividends) is rarely specified.
  Small definitional differences move a ~3-point gap materially.
- **Survivorship / selection framing.** A Claude book and a Grok book are both
  promoted; naturally the one that is currently ahead gets the headline. Judge
  the *ex-ante rule* (published, rebalanced, copy-traded) rather than the
  *ex-post winner*.
- **It is a marketing surface too.** The portfolios are the funnel for a
  copy-trading marketplace. That does not make the numbers wrong, but it is a
  reason to verify them independently before acting.
- **Costs and slippage.** Copy-traders do not get the model's mid-quote fills;
  their realized return will trail the published one after spread, commissions,
  and rebalancing turnover.

## Relationship to this repository

This repo (`polymarket-btc-arb`) is a **prediction-market arbitrage** system,
not an equity strategy — a different asset class, a different edge (deterministic
basket redemption, not directional stock selection), and a different risk model
(market-neutral baskets vs a concentrated long book). The two share only the
theme of *agent-run trading*. The single most transferable lesson from the arb
side to reading this equity experiment: **net-of-cost, verified-fill numbers are
the only ones that count** — the same discipline this repo applies by folding
per-token fees into every price before it claims an edge (see `README.md` and
`src/arbMath.ts`).

## Sources

- [Claude AI autonomous portfolio just launched; it picked these stocks to beat the market — Finbold](https://finbold.com/claude-ai-autonomous-portfolio-just-launched-it-picked-these-stocks-to-beat-the-market/)
- [Claude is running a $50K portfolio with zero human override — DEV Community](https://dev.to/o96a/claude-is-running-a-50k-portfolio-with-zero-human-override-the-implications-go-beyond-finance-440)
- [Claude Stock Portfolio: top 10 stocks according to the AI chatbot — Insider Monkey](https://www.insidermonkey.com/blog/claude-stock-portfolio-top-10-stocks-to-buy-according-to-ai-chatbot-1765471/)
- [Broadcom (AVGO) is among Claude AI's top stock picks for 2026 — Insider Monkey](https://www.insidermonkey.com/blog/broadcom-avgo-is-among-claude-ais-top-stock-picks-for-2026-1770841/)
- [Grok outpaces Claude AI in stock trading — Yahoo Finance](https://finance.yahoo.com/markets/stocks/articles/grok-outpaces-claude-ai-stock-201716614.html)
- [A Claude agent bought these two trillion-dollar AI stocks before the ceasefire — The Motley Fool](https://www.fool.com/investing/2026/04/13/a-claude-agent-bought-these-2-trillion-dollar-arti/)
- [View Claude Portfolio on Autopilot](https://marketplace.joinautopilot.com/landing/5/950048)

_All figures are as reported on the dates noted and were not independently
re-derived from primary brokerage statements. Past performance does not predict
future results. This is not investment advice._
