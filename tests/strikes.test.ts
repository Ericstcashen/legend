import { describe, expect, it } from "vitest";
import { crossStrikePairs, groupStrikeFamilies, parseStrike } from "../src/strikes.js";
import type { BtcMarket } from "../src/types.js";

function market(question: string, endDateIso = "2026-06-13T00:00:00Z"): BtcMarket {
	return {
		question,
		conditionId: `c-${question}`,
		slug: "",
		endDateIso,
		yesTokenId: `yes-${question}`,
		noTokenId: `no-${question}`,
		negRisk: false,
	};
}

describe("parseStrike", () => {
	it("parses 'above $110,000' as an up strike", () => {
		const info = parseStrike("Will Bitcoin be above $110,000 on June 13?");
		expect(info).toMatchObject({ strike: 110_000, direction: "up" });
	});

	it("parses $150K shorthand", () => {
		const info = parseStrike("Will Bitcoin reach $150K by December 31?");
		expect(info).toMatchObject({ strike: 150_000, direction: "up" });
	});

	it("parses 'dip to' as a down strike", () => {
		const info = parseStrike("Will Bitcoin dip to $80,000 in June?");
		expect(info).toMatchObject({ strike: 80_000, direction: "down" });
	});

	it("rejects range questions with two strikes", () => {
		expect(parseStrike("Will Bitcoin be between $100,000 and $110,000 on June 13?")).toBeNull();
	});

	it("rejects undirected questions", () => {
		expect(parseStrike("Will Bitcoin close at $105,000 on June 13?")).toBeNull();
	});

	it("produces the same family key for different strikes of one template", () => {
		const a = parseStrike("Will Bitcoin be above $100,000 on June 13?");
		const b = parseStrike("Will Bitcoin be above $120,000 on June 13?");
		expect(a!.familyKey).toBe(b!.familyKey);
	});
});

describe("groupStrikeFamilies / crossStrikePairs", () => {
	const m100 = market("Will Bitcoin be above $100,000 on June 13?");
	const m110 = market("Will Bitcoin be above $110,000 on June 13?");
	const m120 = market("Will Bitcoin be above $120,000 on June 13?");

	it("groups same-template markets and sorts by strike", () => {
		const families = groupStrikeFamilies([m120, m100, m110]);
		expect(families).toHaveLength(1);
		expect(families[0]!.markets.map((m) => m.strike)).toEqual([100_000, 110_000, 120_000]);
	});

	it("does not mix different end dates", () => {
		const other = market("Will Bitcoin be above $110,000 on June 13?", "2026-07-01T00:00:00Z");
		expect(groupStrikeFamilies([m100, other])).toHaveLength(0);
	});

	it("buys YES at the lower strike for up families", () => {
		const families = groupStrikeFamilies([m100, m110]);
		const pairs = crossStrikePairs(families[0]!);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]!.yesMarket).toBe(m100);
		expect(pairs[0]!.noMarket).toBe(m110);
	});

	it("buys YES at the higher strike for down families", () => {
		const d80 = market("Will Bitcoin dip to $80,000 in June?");
		const d90 = market("Will Bitcoin dip to $90,000 in June?");
		const families = groupStrikeFamilies([d80, d90]);
		const pairs = crossStrikePairs(families[0]!);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]!.yesMarket).toBe(d90);
		expect(pairs[0]!.noMarket).toBe(d80);
	});
});
