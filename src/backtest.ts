import type { ArbLeg } from "./types.js";
import { allocate } from "./allocator.js";
import { Cooldown } from "./risk.js";
import { parseRecording, type Snapshot } from "./record.js";
import { findAllArbs } from "./strategies.js";

export interface BacktestParams {
	minEdge: number;
	maxUsdPerTrade: number;
	dailyBudget: number;
	/** Don't re-book the same opportunity within this window (ms). */
	cooldownMs: number;
}

export interface BacktestReport {
	snapshots: number;
	/** Opportunities seen across all snapshots (pre-cooldown). */
	opportunitiesSeen: number;
	/** Executable baskets actually booked after cooldown + budget. */
	booked: number;
	manualSeen: number;
	deployed: number;
	profit: number;
	roiPct: number;
	byKind: Record<string, { count: number; profit: number }>;
	/** Distinct snapshots in which at least one arb existed. */
	snapshotsWithArb: number;
}

/**
 * Replay recorded snapshots through the live strategy/allocator/cooldown
 * pipeline and measure realized paper P&L — the same math that runs live,
 * applied to real recorded books. This is the in-house measurement of "does
 * this make money on real market conditions" once recordings exist.
 */
export function backtest(snapshots: Snapshot[], params: BacktestParams): BacktestReport {
	const cooldown = new Cooldown(params.cooldownMs);
	const report: BacktestReport = {
		snapshots: snapshots.length,
		opportunitiesSeen: 0,
		booked: 0,
		manualSeen: 0,
		deployed: 0,
		profit: 0,
		roiPct: 0,
		byKind: {},
		snapshotsWithArb: 0,
	};

	// Budget resets per UTC day inferred from snapshot timestamps.
	let day = "";
	let spentToday = 0;

	for (const snap of snapshots) {
		const legs = new Map<string, ArbLeg>(snap.legs.map((l) => [l.tokenId, l]));
		const opportunities = findAllArbs({
			markets: snap.markets,
			legs,
			minEdge: params.minEdge,
			maxUsdPerTrade: params.maxUsdPerTrade,
		});
		if (opportunities.length > 0) report.snapshotsWithArb++;

		const snapDay = snap.ts.slice(0, 10);
		if (snapDay !== day) {
			day = snapDay;
			spentToday = 0;
		}

		const now = Date.parse(snap.ts) || Date.now();
		const fresh = opportunities.filter((o) => !cooldown.active(o, now));
		report.opportunitiesSeen += fresh.length;
		report.manualSeen += fresh.filter((o) => !o.executable).length;

		const executable = fresh.filter((o) => o.executable);
		const remaining = Math.max(0, params.dailyBudget - spentToday);
		const { chosen } = allocate(executable, remaining);

		for (const opp of chosen) {
			cooldown.mark(opp, now);
			spentToday += opp.totalCost;
			report.booked++;
			report.deployed += opp.totalCost;
			report.profit += opp.profit;
			const k = (report.byKind[opp.kind] ??= { count: 0, profit: 0 });
			k.count++;
			k.profit += opp.profit;
		}
		// Manual (mint-sell) baskets are also cooldown-marked so they aren't recounted.
		for (const opp of fresh.filter((o) => !o.executable)) cooldown.mark(opp, now);
	}

	report.roiPct = report.deployed > 0 ? (report.profit / report.deployed) * 100 : 0;
	return report;
}

function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= process.argv.length) return fallback;
	const v = Number(process.argv[i + 1]);
	return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
	const { readFileSync } = await import("node:fs");
	const fileIdx = process.argv.indexOf("--file");
	const file = fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined;
	if (!file) {
		console.error("usage: tsx src/backtest.ts --file <recording.jsonl> [--min-edge E] [--budget B]");
		process.exit(2);
	}

	const snapshots = parseRecording(readFileSync(file, "utf8"));
	if (snapshots.length === 0) {
		console.error(`no snapshots parsed from ${file}`);
		process.exit(1);
	}

	const report = backtest(snapshots, {
		minEdge: arg("min-edge", 0.01),
		maxUsdPerTrade: arg("max-per-trade", 100),
		dailyBudget: arg("budget", 500),
		cooldownMs: arg("cooldown-ms", 10 * 60 * 1000),
	});

	console.log(`backtest of ${file}`);
	console.log(`  snapshots: ${report.snapshots} (${report.snapshotsWithArb} contained an arb)`);
	console.log(`  opportunities seen: ${report.opportunitiesSeen} | manual (mint-sell): ${report.manualSeen}`);
	console.log(`  booked: ${report.booked} | deployed $${report.deployed.toFixed(2)} | profit $${report.profit.toFixed(2)}`);
	console.log(`  ROI on deployed capital: ${report.roiPct.toFixed(2)}%`);
	for (const [kind, s] of Object.entries(report.byKind)) {
		console.log(`    ${kind}: ${s.count} baskets, $${s.profit.toFixed(2)} profit`);
	}
}

// Only run as a CLI, not when imported by tests.
if (process.argv[1]?.endsWith("backtest.ts") || process.argv[1]?.endsWith("backtest.js")) {
	void main();
}
