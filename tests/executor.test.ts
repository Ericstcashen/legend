import { describe, expect, it, vi } from "vitest";
import { LiveExecutor } from "../src/executor.js";
import type { ArbOpportunity, ArbPlanLeg } from "../src/types.js";

function planLeg(tokenId: string, shares: number, cost: number, capPrice: number): ArbPlanLeg {
	return {
		leg: {
			tokenId,
			marketQuestion: "q",
			outcome: tokenId.includes("yes") ? "Yes" : "No",
			asks: [],
			bids: [],
			tickSize: "0.01",
			negRisk: false,
		},
		shares,
		cost,
		capPrice,
	};
}

function opp(legs: ArbPlanLeg[]): ArbOpportunity {
	const totalCost = legs.reduce((s, l) => s + l.cost, 0);
	return {
		kind: "pair",
		description: "test",
		legs,
		shares: legs[0]!.shares,
		totalCost,
		guaranteedValue: legs[0]!.shares,
		profit: legs[0]!.shares - totalCost,
		edge: 0.05,
		executable: true,
	};
}

interface OrderResp {
	success: boolean;
	orderID?: string;
	errorMsg?: string;
}

function mockClient() {
	return {
		createOrder: vi.fn(async (userOrder: unknown) => ({ signed: userOrder })),
		postOrder: vi.fn(async (..._args: unknown[]): Promise<OrderResp> => ({
			success: true,
			orderID: "o1",
		})),
	};
}

describe("LiveExecutor.buyLeg ordering", () => {
	it("posts each leg as a FOK limit order with the EXACT planned share size", async () => {
		const client = mockClient();
		const exec = new LiveExecutor(client as never, () => false);
		// Multi-level leg: average cost 0.42/sh but cap 0.45 — a dollar order would
		// underfill to 42/0.45=93.3 sh; the size-based order must request 100.
		const o = opp([planLeg("yes-1", 100, 42, 0.45), planLeg("no-1", 100, 50, 0.52)]);

		const result = await exec.execute(o);
		expect(result.executed).toBe(true);
		expect(result.filledLegs).toBe(2);

		// createOrder called with size = planned shares (not derived from dollars)
		const sizes = client.createOrder.mock.calls.map((c) => (c[0] as { size: number }).size);
		expect(sizes).toEqual([100, 100]);
		const prices = client.createOrder.mock.calls.map((c) => (c[0] as { price: number }).price);
		expect(prices).toEqual([0.45, 0.52]);
		// posted FOK on every leg
		for (const call of client.postOrder.mock.calls) expect(call[1]).toBe("FOK");
	});

	it("stops and reports unhedged exposure when a later leg is rejected", async () => {
		const client = mockClient();
		client.postOrder
			.mockResolvedValueOnce({ success: true, orderID: "o1" })
			.mockResolvedValueOnce({ success: false, errorMsg: "no liquidity" });
		const exec = new LiveExecutor(client as never, () => false);
		const o = opp([planLeg("yes-1", 100, 42, 0.45), planLeg("no-1", 100, 50, 0.52)]);

		const result = await exec.execute(o);
		expect(result.filledLegs).toBe(1);
		expect(result.executed).toBe(true); // partial: one leg filled
		expect(result.error).toContain("no liquidity");
	});

	it("refuses to place any order when the kill switch is active", async () => {
		const client = mockClient();
		const exec = new LiveExecutor(client as never, () => true);
		const result = await exec.execute(opp([planLeg("yes-1", 100, 42, 0.45)]));
		expect(result.executed).toBe(false);
		expect(client.createOrder).not.toHaveBeenCalled();
	});
});
