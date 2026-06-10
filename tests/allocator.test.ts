import { describe, expect, it } from "vitest";
import { allocate, Bankroll } from "../src/allocator.js";
import type { ArbOpportunity } from "../src/types.js";

let token = 0;
function opp(profit: number, cost: number, tokens?: string[]): ArbOpportunity {
	const legTokens = tokens ?? [`t${token++}`, `t${token++}`];
	return {
		kind: "pair",
		description: "x",
		legs: legTokens.map((t) => ({
			leg: {
				tokenId: t,
				marketQuestion: "q",
				outcome: "Yes",
				asks: [],
				bids: [],
				tickSize: "0.01",
				negRisk: false,
			},
			shares: 1,
			cost: cost / legTokens.length,
			capPrice: 0.5,
		})),
		shares: 1,
		totalCost: cost,
		guaranteedValue: cost + profit,
		profit,
		edge: profit / cost,
		executable: true,
	};
}

describe("allocate", () => {
	it("prefers higher ROI over higher absolute profit when budget binds", () => {
		// $0.50 on $5 (10% edge) vs $0.60 on $90 (0.67% edge); budget only fits one.
		const small = opp(0.5, 5);
		const big = opp(0.6, 90);
		const { chosen, profit } = allocate([big, small], 90);
		// profit-first would pick big ($0.60); ROI-first picks small AND leaves room
		expect(chosen).toContain(small);
		expect(profit).toBeGreaterThanOrEqual(0.5);
	});

	it("packs multiple baskets within budget, highest edge first", () => {
		const a = opp(2, 10); // 20%
		const b = opp(1, 10); // 10%
		const c = opp(0.5, 10); // 5%
		const { chosen, spend } = allocate([c, a, b], 20);
		expect(chosen).toEqual([a, b]);
		expect(spend).toBe(20);
	});

	it("skips baskets sharing a token with an already-funded basket", () => {
		const a = opp(2, 10, ["shared", "x"]);
		const b = opp(1.9, 10, ["shared", "y"]);
		const { chosen } = allocate([a, b], 100);
		expect(chosen).toEqual([a]); // b shares 'shared'
	});

	it("returns nothing when budget is zero", () => {
		expect(allocate([opp(1, 10)], 0).chosen).toEqual([]);
	});
});

describe("Bankroll circuit breaker", () => {
	it("does not halt on small fluctuations", () => {
		const b = new Bankroll(1000, 0.1);
		b.update(5);
		b.update(-3);
		expect(b.halted).toBe(false);
	});

	it("halts after a sustained drawdown past the threshold", () => {
		const b = new Bankroll(1000, 0.1, 1); // alpha=1: equity tracks exactly
		b.update(-150); // 15% below peak
		expect(b.halted).toBe(true);
	});

	it("resets after recovery (hysteresis)", () => {
		const b = new Bankroll(1000, 0.1, 1);
		b.update(-150);
		expect(b.halted).toBe(true);
		b.update(120); // back near peak, drawdown < 5%
		expect(b.halted).toBe(false);
	});
});
