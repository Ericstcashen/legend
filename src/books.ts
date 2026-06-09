import type { ClobClient, OrderBookSummary } from "@polymarket/clob-client-v2";
import { feeAdjustAsks, feeAdjustBids } from "./arbMath.js";
import type { ArbLeg, BookLevel, BtcMarket } from "./types.js";

function parseLevels(levels: { price: string; size: string }[] | undefined): BookLevel[] {
	return (levels ?? [])
		.map((l) => ({ price: Number(l.price), size: Number(l.size) }))
		.filter((l) => l.price > 0 && l.size > 0);
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

	/** Warm the fee cache for all tokens concurrently (only uncached ones hit the API). */
	private async prefetchFees(tokenIds: string[]): Promise<void> {
		const missing = tokenIds.filter((id) => !this.feeRateCache.has(id));
		await Promise.all(missing.map((id) => this.feeRateBps(id)));
	}

	/**
	 * Fetch fee-adjusted books (both sides) for both outcomes of every market.
	 * Batches run concurrently to keep scan latency low; failed batches are skipped.
	 */
	async fetchLegs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>> {
		const legs = new Map<string, ArbLeg>();
		const wanted: { market: BtcMarket; tokenId: string; outcome: string }[] = [];
		for (const m of markets) {
			wanted.push({ market: m, tokenId: m.yesTokenId, outcome: "Yes" });
			wanted.push({ market: m, tokenId: m.noTokenId, outcome: "No" });
		}

		await this.prefetchFees(wanted.map((w) => w.tokenId));

		const batchSize = 50;
		const batches: (typeof wanted)[] = [];
		for (let i = 0; i < wanted.length; i += batchSize) {
			batches.push(wanted.slice(i, i + batchSize));
		}

		const results = await Promise.all(
			batches.map(async (batch) => {
				try {
					const books = await this.client.getOrderBooks(
						batch.map((w) => ({ token_id: w.tokenId })) as never,
					);
					return { batch, books };
				} catch (err) {
					console.warn(`orderbook batch failed: ${(err as Error).message}`);
					return { batch, books: [] as OrderBookSummary[] };
				}
			}),
		);

		for (const { batch, books } of results) {
			const byToken = new Map(books.map((b) => [b.asset_id, b]));
			for (const w of batch) {
				const book = byToken.get(w.tokenId);
				if (!book) continue;
				const feeRate = this.feeRateCache.get(w.tokenId) ?? 0;
				const asks = parseLevels(book.asks).sort((a, b) => a.price - b.price);
				const bids = parseLevels(book.bids).sort((a, b) => b.price - a.price);
				legs.set(w.tokenId, {
					tokenId: w.tokenId,
					marketQuestion: w.market.question,
					outcome: w.outcome,
					asks: feeAdjustAsks(asks, feeRate),
					bids: feeAdjustBids(bids, feeRate),
					tickSize: book.tick_size || "0.01",
					negRisk: book.neg_risk ?? w.market.negRisk,
				});
			}
		}
		return legs;
	}
}
