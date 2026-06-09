import type { ClobClient, OrderBookSummary } from "@polymarket/clob-client-v2";
import { feeAdjustAsks } from "./arbMath.js";
import type { ArbLeg, BookLevel, BtcMarket } from "./types.js";

function parseAsks(book: OrderBookSummary): BookLevel[] {
	return (book.asks ?? [])
		.map((l) => ({ price: Number(l.price), size: Number(l.size) }))
		.filter((l) => l.price > 0 && l.size > 0)
		.sort((a, b) => a.price - b.price);
}

export class BookFetcher {
	private feeRateCache = new Map<string, number>();

	constructor(private client: ClobClient) {}

	private async feeRateBps(tokenId: string): Promise<number> {
		const cached = this.feeRateCache.get(tokenId);
		if (cached !== undefined) return cached;
		let rate = 0;
		try {
			rate = await this.client.getFeeRateBps(tokenId);
		} catch {
			// Missing fee info: assume 0 bps, which matches Polymarket's base fee.
		}
		this.feeRateCache.set(tokenId, rate);
		return rate;
	}

	/**
	 * Fetch fee-adjusted ask books for both outcomes of every market.
	 * Returns a map keyed by tokenId; markets whose books fail to load are skipped.
	 */
	async fetchLegs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>> {
		const legs = new Map<string, ArbLeg>();
		const wanted: { market: BtcMarket; tokenId: string; outcome: string }[] = [];
		for (const m of markets) {
			wanted.push({ market: m, tokenId: m.yesTokenId, outcome: "Yes" });
			wanted.push({ market: m, tokenId: m.noTokenId, outcome: "No" });
		}

		const batchSize = 50;
		for (let i = 0; i < wanted.length; i += batchSize) {
			const batch = wanted.slice(i, i + batchSize);
			let books: OrderBookSummary[];
			try {
				books = await this.client.getOrderBooks(
					batch.map((w) => ({ token_id: w.tokenId })) as never,
				);
			} catch (err) {
				console.warn(`orderbook batch failed: ${(err as Error).message}`);
				continue;
			}
			const byToken = new Map(books.map((b) => [b.asset_id, b]));
			for (const w of batch) {
				const book = byToken.get(w.tokenId);
				if (!book) continue;
				const feeRate = await this.feeRateBps(w.tokenId);
				legs.set(w.tokenId, {
					tokenId: w.tokenId,
					marketQuestion: w.market.question,
					outcome: w.outcome,
					asks: feeAdjustAsks(parseAsks(book), feeRate),
					tickSize: book.tick_size || "0.01",
					negRisk: book.neg_risk ?? w.market.negRisk,
				});
			}
		}
		return legs;
	}
}
