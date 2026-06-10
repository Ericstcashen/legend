import { describe, expect, it } from "vitest";
import { captureEfficiency, maxBinaryRisklessProfit } from "../src/optimality.js";
import { DEFAULT_SIM, generateRound, Mulberry32 } from "../src/sim.js";
import { findMintSellArbs, findPairArbs } from "../src/strategies.js";
import type { ArbLeg, ArbOpportunity, BtcMarket } from "../src/types.js";

/**
 * Independent optimality check: across many randomized markets, the profit the
 * pair + mint-sell strategies book on a binary market must equal the
 * independently-derived maximum riskless profit extractable from that book.
 * Any shortfall would mean the trader leaves riskless edge uncaptured.
 */
describe("binary-market optimality", () => {
	it("strategies capture 100% of available riskless profit on binary markets", () => {
		const rng = new Mulberry32(99);
		let totalAvailable = 0;
		let totalCaptured = 0;
		const bigCap = 1e9; // unbounded so capture is depth-limited, not budget-limited

		for (let r = 0; r < 400; r++) {
			const round = generateRound({ ...DEFAULT_SIM, seed: 99 }, rng, r);
			for (const m of round.markets) {
				const yes = round.legs.get(m.yesTokenId) as ArbLeg;
				const no = round.legs.get(m.noTokenId) as ArbLeg;
				const single = new Map<string, ArbLeg>([
					[m.yesTokenId, yes],
					[m.noTokenId, no],
				]);
				const markets: BtcMarket[] = [m];
				const input = { markets, legs: single, minEdge: 0, maxUsdPerTrade: bigCap };

				const captured = sumProfit([...findPairArbs(input), ...findMintSellArbs(input)]);
				const optimal = maxBinaryRisklessProfit(yes, no, bigCap);

				totalCaptured += captured;
				totalAvailable += optimal.total;
				// Per-market: strategies never under- or over-capture the riskless max.
				expect(captured).toBeCloseTo(optimal.total, 4);
			}
		}

		expect(totalAvailable).toBeGreaterThan(0); // the test actually exercised arbs
		const { efficiency } = captureEfficiency(totalAvailable, totalCaptured);
		expect(efficiency).toBeCloseTo(1, 4);
	});

	it("reports full efficiency when no riskless edge exists", () => {
		expect(captureEfficiency(0, 0).efficiency).toBe(1);
	});

	it("detects a shortfall as efficiency < 1", () => {
		expect(captureEfficiency(10, 7).efficiency).toBeCloseTo(0.7);
	});
});

function sumProfit(opps: ArbOpportunity[]): number {
	return opps.reduce((s, o) => s + o.profit, 0);
}
