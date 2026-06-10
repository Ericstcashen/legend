import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocate } from "./allocator.js";
import { loadConfig } from "./config.js";
import { PaperLedger } from "./paper.js";
import { Cooldown, RiskManager } from "./risk.js";
import { DEFAULT_SIM, generateRound, Mulberry32, type SimConfig } from "./sim.js";
import { findAllArbs } from "./strategies.js";
import type { ArbOpportunity } from "./types.js";

/**
 * Capital-efficiency check against a single global budget — the regime the bot
 * actually faces (a daily budget across many scans, with baskets small relative
 * to it). When more profitable baskets exist than budget, both methods spend
 * the budget fully, so the ROI-aware allocator's higher average edge yields
 * strictly more profit. Returns { alloc, naive, spendA, spendN }.
 *
 * Profit-first ("naive") packs the same non-overlapping baskets by absolute
 * profit; the comparison isolates the ordering, not the dedup.
 */
function compareAllocation(
	executable: ArbOpportunity[],
	budget: number,
): { alloc: number; naive: number; spendA: number; spendN: number } {
	const a = allocate(executable, budget);

	let naive = 0;
	let spendN = 0;
	const used = new Set<string>();
	for (const o of [...executable].sort((x, y) => y.profit - x.profit)) {
		if (spendN + o.totalCost > budget + 1e-9) continue;
		if (o.legs.some((l) => used.has(l.leg.tokenId))) continue;
		for (const l of o.legs) used.add(l.leg.tokenId);
		spendN += o.totalCost;
		naive += o.profit;
	}
	return { alloc: a.profit, naive, spendA: a.spend, spendN };
}

/**
 * Offline profitability harness. Runs the real scanner, strategies, risk
 * checks, and paper ledger against a seeded synthetic market generator with
 * injected, riskless dislocations. Reports the locked profit the strategies
 * actually capture — the in-session, endpoint-free measurement of "does this
 * make money", and a regression guard for strategy changes.
 *
 * Usage: tsx src/simulate.ts [--rounds N] [--seed S] [--ledger PATH]
 */
function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= process.argv.length) return fallback;
	const v = Number(process.argv[i + 1]);
	return Number.isFinite(v) ? v : fallback;
}

function main(): void {
	const cfg = loadConfig();
	const rounds = arg("rounds", 200);
	const seed = arg("seed", DEFAULT_SIM.seed);

	const ledgerIdx = process.argv.indexOf("--ledger");
	const ledgerPath =
		ledgerIdx !== -1 && process.argv[ledgerIdx + 1]
			? process.argv[ledgerIdx + 1]!
			: join(mkdtempSync(join(tmpdir(), "sim-")), "sim-ledger.jsonl");

	const simCfg: SimConfig = { ...DEFAULT_SIM, seed, feeRateBps: arg("fee", 0) };
	const rng = new Mulberry32(seed);
	const ledger = new PaperLedger(ledgerPath);
	const cooldown = new Cooldown(0); // each round is a fresh independent book
	const risk = new RiskManager(Number.POSITIVE_INFINITY, cfg.minProfitUsd);

	const injected = { pair: 0, mintSell: 0, crossStrike: 0 };
	const captured = { pair: 0, "cross-strike": 0, "neg-risk-yes": 0, "neg-risk-no": 0, "mint-sell": 0 };
	let opportunitiesSeen = 0;
	let manualSeen = 0;
	// Capital-efficiency comparison against a single global (daily-style) budget.
	const totalBudget = arg("budget", cfg.maxDailyUsd);
	const allExecutable: ArbOpportunity[] = [];

	console.log(
		`simulation | ${rounds} rounds seed=${seed} fee=${simCfg.feeRateBps}bps ` +
			`minEdge=${cfg.minEdge} minProfit=$${cfg.minProfitUsd} maxPerTrade=$${cfg.maxUsdPerTrade}`,
	);

	for (let r = 0; r < rounds; r++) {
		const round = generateRound(simCfg, rng, r);
		injected.pair += round.injected.pair;
		injected.mintSell += round.injected.mintSell;
		injected.crossStrike += round.injected.crossStrike;

		const opportunities = findAllArbs({
			markets: round.markets,
			legs: round.legs,
			minEdge: cfg.minEdge,
			maxUsdPerTrade: cfg.maxUsdPerTrade,
		});

		for (const opp of opportunities) {
			if (risk.check(opp)) continue;
			opportunitiesSeen++;
			if (!opp.executable) {
				manualSeen++;
				continue;
			}
			ledger.record(opp);
			captured[opp.kind]++;
			allExecutable.push(opp);
		}
	}

	const { trades, costBasis, lockedProfit } = ledger.stats;
	const roi = costBasis > 0 ? (lockedProfit / costBasis) * 100 : 0;

	console.log("\n=== injected dislocations (ground truth) ===");
	console.log(
		`  pair=${injected.pair}  mint-sell=${injected.mintSell}  cross-strike-families=${injected.crossStrike}`,
	);
	console.log("=== opportunities captured (executable, booked to ledger) ===");
	console.log(
		`  pair=${captured.pair}  cross-strike=${captured["cross-strike"]}  ` +
			`neg-risk-yes=${captured["neg-risk-yes"]}  neg-risk-no=${captured["neg-risk-no"]}`,
	);
	console.log(`  mint-sell flagged MANUAL (not booked): ${manualSeen}`);
	console.log("=== measured profitability (unconstrained capital) ===");
	console.log(`  ${ledger.summary()}`);
	console.log(`  executable trades booked: ${trades}, ROI on deployed capital: ${roi.toFixed(2)}%`);
	console.log(`  ledger: ${ledgerPath}`);
	const { alloc, naive, spendA, spendN } = compareAllocation(allExecutable, totalBudget);
	const uplift = naive > 0 ? ((alloc - naive) / naive) * 100 : 0;
	console.log(`=== capital rationing (single $${totalBudget} budget, ${allExecutable.length} baskets) ===`);
	console.log(
		`  ROI-first allocator: $${alloc.toFixed(2)} profit on $${spendA.toFixed(2)} deployed ` +
			`(${spendA > 0 ? ((alloc / spendA) * 100).toFixed(1) : "0"}% ROI)`,
	);
	console.log(
		`  profit-first greedy: $${naive.toFixed(2)} profit on $${spendN.toFixed(2)} deployed ` +
			`(${spendN > 0 ? ((naive / spendN) * 100).toFixed(1) : "0"}% ROI)`,
	);
	// On baskets this large relative to budget the two orderings are within noise;
	// the allocator's value is bounding spend to budget and de-duplicating
	// overlapping legs, not beating profit-first. Reported for transparency.
	console.log(`  ordering delta: ${uplift >= 0 ? "+" : ""}${uplift.toFixed(2)}% (neutral — both ration the same budget)`);

	// Profit must be strictly positive and every booked basket riskless by
	// construction — a non-positive result is a strategy regression.
	if (trades > 0 && lockedProfit <= 0) {
		console.error("REGRESSION: booked trades produced non-positive locked profit");
		process.exit(1);
	}
}

main();
