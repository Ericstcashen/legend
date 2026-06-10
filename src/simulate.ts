import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { PaperLedger } from "./paper.js";
import { Cooldown, RiskManager } from "./risk.js";
import { DEFAULT_SIM, generateRound, Mulberry32, type SimConfig } from "./sim.js";
import { findAllArbs } from "./strategies.js";

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
	console.log("=== measured profitability ===");
	console.log(`  ${ledger.summary()}`);
	console.log(`  executable trades booked: ${trades}, ROI on deployed capital: ${roi.toFixed(2)}%`);
	console.log(`  ledger: ${ledgerPath}`);

	// Profit must be strictly positive and every booked basket riskless by
	// construction — a non-positive result is a strategy regression.
	if (trades > 0 && lockedProfit <= 0) {
		console.error("REGRESSION: booked trades produced non-positive locked profit");
		process.exit(1);
	}
}

main();
