import { describe, expect, it } from "vitest";
import {
	adjust,
	DEFAULT_GOAL,
	DEFAULT_SIM_SETTINGS,
	makeVerifier,
	runSimulation,
	type TuneCandidate,
	tune,
} from "../src/tune.js";
import type { Check } from "../src/loop.js";

const START: TuneCandidate = { minEdge: 0.12, maxUsdPerTrade: 20 };

describe("runSimulation (the verifier engine)", () => {
	it("is deterministic for a given candidate and settings", () => {
		const a = runSimulation({ minEdge: 0.03, maxUsdPerTrade: 100 });
		const b = runSimulation({ minEdge: 0.03, maxUsdPerTrade: 100 });
		expect(a).toEqual(b);
	});

	it("books only riskless baskets and a positive net-of-fee profit", () => {
		const m = runSimulation({ minEdge: 0.01, maxUsdPerTrade: 100 });
		expect(m.allRiskless).toBe(true);
		expect(m.netProfit).toBeGreaterThan(0);
		expect(m.capturedPairs).toBeLessThanOrEqual(m.injectedPairs);
	});

	it("raising the edge floor trades capture for ROI", () => {
		const loose = runSimulation({ minEdge: 0.01, maxUsdPerTrade: 100 });
		const tight = runSimulation({ minEdge: 0.08, maxUsdPerTrade: 100 });
		expect(tight.capturedPairs).toBeLessThan(loose.capturedPairs);
		expect(tight.roiPct).toBeGreaterThan(loose.roiPct);
	});

	it("scaling per-trade budget scales deployed capital and profit", () => {
		const small = runSimulation({ minEdge: 0.03, maxUsdPerTrade: 50 });
		const big = runSimulation({ minEdge: 0.03, maxUsdPerTrade: 200 });
		expect(big.netProfit).toBeGreaterThan(small.netProfit);
		expect(big.costBasis).toBeGreaterThan(small.costBasis);
	});
});

describe("adjust (feedback → config moves)", () => {
	const fail = (name: string): Check => ({ name, pass: false, detail: "" });

	it("profit shortfall doubles per-trade budget, capped at 500", () => {
		expect(adjust({ minEdge: 0.05, maxUsdPerTrade: 100 }, [fail("net profit")]).maxUsdPerTrade).toBe(200);
		expect(adjust({ minEdge: 0.05, maxUsdPerTrade: 400 }, [fail("net profit")]).maxUsdPerTrade).toBe(500);
	});

	it("ROI shortfall raises the edge floor; capture shortfall lowers it", () => {
		expect(adjust({ minEdge: 0.05, maxUsdPerTrade: 100 }, [fail("ROI")]).minEdge).toBeCloseTo(0.06, 6);
		expect(adjust({ minEdge: 0.05, maxUsdPerTrade: 100 }, [fail("pair capture")]).minEdge).toBeCloseTo(0.04, 6);
	});

	it("leaves config unchanged when nothing failed", () => {
		const c = { minEdge: 0.05, maxUsdPerTrade: 100 };
		expect(adjust(c, [])).toEqual(c);
	});
});

describe("tune loop", () => {
	it("converges to a config that satisfies the goal, within the cap", async () => {
		const outcome = await tune({
			start: START,
			goal: DEFAULT_GOAL,
			settings: DEFAULT_SIM_SETTINGS,
			maxAttempts: 15,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.attempts).toBeLessThanOrEqual(15);

		// The converged config independently re-verifies as passing.
		const m = outcome.output!;
		const verify = makeVerifier(DEFAULT_GOAL);
		expect(verify(m).ok).toBe(true);
		expect(m.netProfit).toBeGreaterThanOrEqual(DEFAULT_GOAL.minProfit);
		expect(m.roiPct).toBeGreaterThanOrEqual(DEFAULT_GOAL.minRoiPct);
		expect(m.capturedPairs).toBeGreaterThanOrEqual(DEFAULT_GOAL.minCapturedPairs);
		expect(m.allRiskless).toBe(true);
	});

	it("is reproducible — same start + goal converge to the same config", async () => {
		const run = () =>
			tune({ start: START, goal: DEFAULT_GOAL, settings: DEFAULT_SIM_SETTINGS, maxAttempts: 15 });
		const a = await run();
		const b = await run();
		expect(a.attempts).toBe(b.attempts);
		expect(a.output).toEqual(b.output);
	});

	it("stops at the cap (without a pass) when the goal is infeasible", async () => {
		const outcome = await tune({
			start: START,
			goal: { ...DEFAULT_GOAL, minProfit: 1_000_000 },
			settings: DEFAULT_SIM_SETTINGS,
			maxAttempts: 6,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(6);
		expect(failuresOf(outcome.verdict?.checks).map((c) => c.name)).toContain("net profit");
	});
});

function failuresOf(checks: Check[] | undefined): Check[] {
	return (checks ?? []).filter((c) => !c.pass);
}
