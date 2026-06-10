import { describe, expect, it } from "vitest";
import { backtest } from "../src/backtest.js";
import { parseRecording, type Snapshot } from "../src/record.js";
import { DEFAULT_SIM, generateRound, Mulberry32 } from "../src/sim.js";

/** Build a recording from the synthetic generator so the backtester has real-shaped input. */
function syntheticRecording(rounds: number, seed = 7): Snapshot[] {
	const rng = new Mulberry32(seed);
	const snaps: Snapshot[] = [];
	for (let r = 0; r < rounds; r++) {
		const round = generateRound({ ...DEFAULT_SIM, seed }, rng, r);
		snaps.push({
			ts: new Date(Date.UTC(2026, 5, 10, 0, 0, r)).toISOString(),
			markets: round.markets,
			legs: [...round.legs.values()],
		});
	}
	return snaps;
}

describe("parseRecording", () => {
	it("round-trips snapshots through JSONL and skips corrupt lines", () => {
		const snaps = syntheticRecording(2);
		const jsonl = `${snaps.map((s) => JSON.stringify(s)).join("\n")}\n{bad json\n`;
		const parsed = parseRecording(jsonl);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]!.markets.length).toBe(snaps[0]!.markets.length);
	});
});

describe("backtest", () => {
	const params = { minEdge: 0.01, maxUsdPerTrade: 100, dailyBudget: 1e9, cooldownMs: 0 };

	it("measures positive ROI on recordings that contain arbitrage", () => {
		const report = backtest(syntheticRecording(100), params);
		expect(report.booked).toBeGreaterThan(0);
		expect(report.profit).toBeGreaterThan(0);
		expect(report.roiPct).toBeGreaterThan(0);
		expect(report.deployed).toBeGreaterThan(0);
	});

	it("books no trades and zero profit on an empty recording", () => {
		const report = backtest([], params);
		expect(report).toMatchObject({ snapshots: 0, booked: 0, profit: 0, roiPct: 0 });
	});

	it("respects the daily budget", () => {
		const report = backtest(syntheticRecording(50), { ...params, dailyBudget: 50 });
		// Each snapshot shares one UTC day here, so total deploy is capped at budget.
		expect(report.deployed).toBeLessThanOrEqual(50 + 1e-6);
	});

	it("counts mint-sell opportunities as manual, never booked", () => {
		const report = backtest(syntheticRecording(100), params);
		expect(report.byKind["mint-sell"]).toBeUndefined();
		expect(report.manualSeen).toBeGreaterThan(0);
	});

	it("cooldown suppresses re-booking a persistent arb across snapshots", () => {
		// Same single market repeated; with a long cooldown it should book once.
		const base = syntheticRecording(1)[0]!;
		const repeated: Snapshot[] = Array.from({ length: 5 }, (_, i) => ({
			...base,
			ts: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString(),
		}));
		const withCd = backtest(repeated, { ...params, cooldownMs: 60_000 });
		const noCd = backtest(repeated, { ...params, cooldownMs: 0 });
		expect(withCd.booked).toBeLessThan(noCd.booked);
	});
});
