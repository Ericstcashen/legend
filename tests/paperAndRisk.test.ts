import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PaperLedger } from "../src/paper.js";
import { Cooldown } from "../src/risk.js";
import type { ArbOpportunity } from "../src/types.js";

function opp(overrides: Partial<ArbOpportunity> = {}): ArbOpportunity {
	return {
		kind: "pair",
		description: "test",
		legs: [
			{
				leg: {
					tokenId: "yes-1",
					marketQuestion: "q",
					outcome: "Yes",
					asks: [],
					bids: [],
					tickSize: "0.01",
					negRisk: false,
				},
				shares: 10,
				cost: 5,
				capPrice: 0.5,
			},
		],
		shares: 10,
		totalCost: 9.5,
		guaranteedValue: 10,
		profit: 0.5,
		edge: 0.5 / 9.5,
		executable: true,
		...overrides,
	};
}

describe("PaperLedger", () => {
	it("accumulates fills and survives a restart", () => {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "trades.jsonl");
		const ledger = new PaperLedger(path);
		ledger.record(opp());
		ledger.record(opp({ totalCost: 19, profit: 1, guaranteedValue: 20, shares: 20 }));

		expect(ledger.stats).toEqual({ trades: 2, costBasis: 28.5, lockedProfit: 1.5 });
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);

		const reloaded = new PaperLedger(path);
		expect(reloaded.stats).toEqual(ledger.stats);
		expect(reloaded.summary()).toContain("2 fills");
	});

	it("reports no fills on an empty ledger", () => {
		const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "trades.jsonl");
		expect(new PaperLedger(path).summary()).toContain("no fills");
	});
});

describe("Cooldown", () => {
	it("suppresses the same opportunity within the window and releases after", () => {
		const cd = new Cooldown(1000);
		const a = opp();
		expect(cd.active(a, 0)).toBe(false);
		cd.mark(a, 0);
		expect(cd.active(a, 500)).toBe(true);
		expect(cd.active(a, 1500)).toBe(false);
	});

	it("keys by kind and leg tokens", () => {
		const cd = new Cooldown(1000);
		cd.mark(opp(), 0);
		expect(cd.active(opp({ kind: "mint-sell" }), 100)).toBe(false);
	});
});
