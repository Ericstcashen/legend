import { describe, expect, it } from "vitest";
import { DEFAULT_SIM, generateRound, Mulberry32, type SimConfig } from "../src/sim.js";
import { findAllArbs } from "../src/strategies.js";
import type { ArbOpportunity } from "../src/types.js";

function runSim(cfg: SimConfig, rounds: number, minEdge = 0.01, maxUsd = 100) {
	const rng = new Mulberry32(cfg.seed);
	const all: ArbOpportunity[] = [];
	const injected = { pair: 0, mintSell: 0, crossStrike: 0 };
	for (let r = 0; r < rounds; r++) {
		const round = generateRound(cfg, rng, r);
		injected.pair += round.injected.pair;
		injected.mintSell += round.injected.mintSell;
		injected.crossStrike += round.injected.crossStrike;
		all.push(
			...findAllArbs({ markets: round.markets, legs: round.legs, minEdge, maxUsdPerTrade: maxUsd }),
		);
	}
	return { opportunities: all, injected };
}

describe("simulation harness", () => {
	it("is deterministic for a given seed", () => {
		const a = runSim({ ...DEFAULT_SIM, seed: 42 }, 50);
		const b = runSim({ ...DEFAULT_SIM, seed: 42 }, 50);
		expect(a.opportunities.length).toBe(b.opportunities.length);
		const sum = (os: ArbOpportunity[]) => os.reduce((s, o) => s + o.profit, 0);
		expect(sum(a.opportunities)).toBeCloseTo(sum(b.opportunities), 6);
	});

	it("every reported opportunity clears the edge and is riskless (cost < guaranteed value)", () => {
		const { opportunities } = runSim({ ...DEFAULT_SIM, seed: 7, feeRateBps: 60 }, 200);
		expect(opportunities.length).toBeGreaterThan(0);
		for (const opp of opportunities) {
			expect(opp.profit).toBeGreaterThan(0);
			expect(opp.edge).toBeGreaterThanOrEqual(0.01 - 1e-9);
			expect(opp.totalCost).toBeLessThan(opp.guaranteedValue);
		}
	});

	it("captures every injected pair arb", () => {
		const { opportunities, injected } = runSim({ ...DEFAULT_SIM, seed: 7 }, 200);
		const pairCaptured = opportunities.filter((o) => o.kind === "pair").length;
		expect(pairCaptured).toBe(injected.pair);
	});

	it("accumulates positive executable profit net of fees", () => {
		const { opportunities } = runSim({ ...DEFAULT_SIM, seed: 3, feeRateBps: 60 }, 200);
		const executable = opportunities.filter((o) => o.executable);
		const profit = executable.reduce((s, o) => s + o.profit, 0);
		expect(executable.length).toBeGreaterThan(0);
		expect(profit).toBeGreaterThan(0);
	});

	it("flags mint-sell opportunities as manual, never executable", () => {
		const { opportunities } = runSim({ ...DEFAULT_SIM, seed: 5, mintSellProb: 0.5 }, 100);
		const mintSell = opportunities.filter((o) => o.kind === "mint-sell");
		expect(mintSell.length).toBeGreaterThan(0);
		expect(mintSell.every((o) => !o.executable)).toBe(true);
	});
});
