import { describe, expect, it } from "vitest";
import { applyMarketMessage, BookState } from "../src/wsBook.js";

describe("BookState snapshots", () => {
	it("loads a book snapshot and returns sorted top-of-book", () => {
		const s = new BookState();
		s.applySnapshot(
			"a",
			[
				{ price: "0.40", size: "100" },
				{ price: "0.42", size: "50" },
			],
			[
				{ price: "0.45", size: "80" },
				{ price: "0.44", size: "60" },
			],
		);
		// bids best (highest) first, asks best (lowest) first
		expect(s.bidsFor("a").map((l) => l.price)).toEqual([0.42, 0.4]);
		expect(s.asksFor("a").map((l) => l.price)).toEqual([0.44, 0.45]);
	});

	it("drops out-of-range and non-positive levels", () => {
		const s = new BookState();
		s.applySnapshot(
			"a",
			[
				{ price: "0.0005", size: "100" },
				{ price: "0.40", size: "0" },
				{ price: "0.41", size: "10" },
			],
			[],
		);
		expect(s.bidsFor("a").map((l) => l.price)).toEqual([0.41]);
	});
});

describe("BookState incremental changes", () => {
	it("adds, updates, and removes levels", () => {
		const s = new BookState();
		s.applySnapshot("a", [{ price: "0.40", size: "100" }], [{ price: "0.45", size: "50" }]);
		s.applyChanges("a", [
			["BUY", "0.41", "30"], // new bid
			["BUY", "0.40", "120"], // update existing bid
			["SELL", "0.45", "0"], // remove ask
			["SELL", "0.46", "70"], // new ask
		]);
		expect(s.bidsFor("a")).toEqual([
			{ price: 0.41, size: 30 },
			{ price: 0.4, size: 120 },
		]);
		expect(s.asksFor("a")).toEqual([{ price: 0.46, size: 70 }]);
	});

	it("tracks staleness per asset", () => {
		const s = new BookState();
		s.applySnapshot("a", [], [{ price: "0.5", size: "10" }], 1_000);
		expect(s.ageMs("a", 1_400)).toBe(400);
		expect(s.hasBook("a")).toBe(true);
		expect(s.hasBook("missing")).toBe(false);
		expect(s.ageMs("missing")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("applyMarketMessage", () => {
	it("routes book and price_change events; ignores junk", () => {
		const s = new BookState();
		applyMarketMessage(s, {
			event_type: "book",
			asset_id: "a",
			bids: [{ price: "0.40", size: "100" }],
			asks: [{ price: "0.45", size: "50" }],
		});
		applyMarketMessage(s, {
			event_type: "price_change",
			asset_id: "a",
			changes: [["BUY", "0.41", "20"]],
		});
		applyMarketMessage(s, { event_type: "book" }); // no asset_id — ignored
		applyMarketMessage(s, null);
		applyMarketMessage(s, "garbage");

		expect(s.bidsFor("a").map((l) => l.price)).toEqual([0.41, 0.4]);
		expect(s.asksFor("a")).toEqual([{ price: 0.45, size: 50 }]);
	});
});
