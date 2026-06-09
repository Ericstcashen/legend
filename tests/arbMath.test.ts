import { describe, expect, it } from "vitest";
import {
	feeAdjustAsks,
	feeAdjustBids,
	jointFill,
	jointFillBids,
	planArb,
	planMintSell,
} from "../src/arbMath.js";
import type { ArbLeg } from "../src/types.js";

function leg(asks: [number, number][], bids: [number, number][] = []): ArbLeg {
	return {
		tokenId: "t",
		marketQuestion: "q",
		outcome: "Yes",
		asks: asks.map(([price, size]) => ({ price, size })),
		bids: bids.map(([price, size]) => ({ price, size })),
		tickSize: "0.01",
		negRisk: false,
	};
}

describe("feeAdjustAsks", () => {
	it("returns asks unchanged at 0 bps", () => {
		const asks = [{ price: 0.4, size: 10 }];
		expect(feeAdjustAsks(asks, 0)).toEqual(asks);
	});

	it("adds rate * min(p, 1-p) to each level", () => {
		const [adjusted] = feeAdjustAsks([{ price: 0.7, size: 10 }], 200);
		expect(adjusted!.price).toBeCloseTo(0.7 + 0.02 * 0.3, 10);
	});
});

describe("jointFill", () => {
	it("fills nothing when the best combined price exceeds the threshold", () => {
		const fill = jointFill([[{ price: 0.6, size: 10 }], [{ price: 0.45, size: 10 }]], 1.0);
		expect(fill.shares).toBe(0);
	});

	it("fills the overlap of top levels", () => {
		const fill = jointFill([[{ price: 0.5, size: 10 }], [{ price: 0.45, size: 4 }]], 1.0);
		expect(fill.shares).toBe(4);
		expect(fill.totalCost).toBeCloseTo(4 * 0.95);
		expect(fill.perLeg[0]!.capPrice).toBe(0.5);
	});

	it("walks deeper levels while the marginal set price clears", () => {
		const yes = [
			{ price: 0.5, size: 5 },
			{ price: 0.52, size: 5 },
		];
		const no = [
			{ price: 0.45, size: 5 },
			{ price: 0.5, size: 5 },
		];
		// sets 1-5 cost 0.95, sets 6-10 cost 1.02 > 1.0 threshold
		const fill = jointFill([yes, no], 1.0);
		expect(fill.shares).toBe(5);
		expect(fill.totalCost).toBeCloseTo(5 * 0.95);
	});

	it("respects maxShares", () => {
		const fill = jointFill([[{ price: 0.4, size: 100 }], [{ price: 0.4, size: 100 }]], 1.0, 7);
		expect(fill.shares).toBe(7);
	});
});

describe("planArb", () => {
	it("returns null when no edge", () => {
		const plan = planArb([leg([[0.55, 10]]), leg([[0.5, 10]])], 1, 0.01, 1000);
		expect(plan).toBeNull();
	});

	it("plans a profitable basket and reports edge", () => {
		const plan = planArb([leg([[0.5, 10]]), leg([[0.45, 10]])], 1, 0.01, 1000);
		expect(plan).not.toBeNull();
		expect(plan!.shares).toBe(10);
		expect(plan!.profit).toBeCloseTo(10 - 9.5);
		expect(plan!.edge).toBeCloseTo(0.5 / 9.5);
	});

	it("caps the spend at maxUsd", () => {
		const plan = planArb([leg([[0.5, 100]]), leg([[0.45, 100]])], 1, 0.01, 19);
		expect(plan).not.toBeNull();
		expect(plan!.totalCost).toBeLessThanOrEqual(19 + 1e-9);
		expect(plan!.shares).toBeCloseTo(20);
	});

	it("supports multi-leg neg-risk baskets with guaranteed value > 1", () => {
		// 3 NO legs at 0.6 each: set costs 1.8, redeems n-1 = 2.
		const legs = [leg([[0.6, 10]]), leg([[0.6, 10]]), leg([[0.6, 10]])];
		const plan = planArb(legs, 2, 0.01, 1000);
		expect(plan).not.toBeNull();
		expect(plan!.profit).toBeCloseTo(10 * (2 - 1.8));
	});
});

describe("feeAdjustBids", () => {
	it("subtracts rate * min(p, 1-p) from proceeds", () => {
		const [adjusted] = feeAdjustBids([{ price: 0.7, size: 10 }], 200);
		expect(adjusted!.price).toBeCloseTo(0.7 - 0.02 * 0.3, 10);
	});
});

describe("jointFillBids", () => {
	it("fills nothing when combined bids are under the floor", () => {
		const fill = jointFillBids([[{ price: 0.5, size: 10 }], [{ price: 0.48, size: 10 }]], 1.0);
		expect(fill.shares).toBe(0);
	});

	it("walks down the bids while the set revenue clears, tracking floor prices", () => {
		const yes = [
			{ price: 0.56, size: 5 },
			{ price: 0.5, size: 5 },
		];
		const no = [{ price: 0.5, size: 10 }];
		// sets 1-5 yield 1.06, sets 6-10 yield 1.00 < 1.01 floor
		const fill = jointFillBids([yes, no], 1.01);
		expect(fill.shares).toBe(5);
		expect(fill.totalCost).toBeCloseTo(5 * 1.06);
		expect(fill.perLeg[0]!.capPrice).toBe(0.56);
	});
});

describe("planMintSell", () => {
	it("returns null when bids never exceed mint cost", () => {
		const yes = leg([], [[0.5, 10]]);
		const no = leg([], [[0.49, 10]]);
		expect(planMintSell([yes, no], 0.01, 1000)).toBeNull();
	});

	it("plans profit as proceeds minus $1-per-set mint cost", () => {
		const yes = leg([], [[0.55, 10]]);
		const no = leg([], [[0.5, 10]]);
		const plan = planMintSell([yes, no], 0.01, 1000);
		expect(plan).not.toBeNull();
		expect(plan!.shares).toBe(10);
		expect(plan!.totalCost).toBeCloseTo(10); // mint cost
		expect(plan!.profit).toBeCloseTo(10 * 0.05);
	});

	it("caps shares at the USD budget", () => {
		const yes = leg([], [[0.55, 100]]);
		const no = leg([], [[0.5, 100]]);
		const plan = planMintSell([yes, no], 0.01, 25);
		expect(plan!.shares).toBeCloseTo(25);
	});
});
