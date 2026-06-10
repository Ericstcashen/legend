import { feeAdjustAsks, feeAdjustBids } from "./arbMath.js";
import type { ArbLeg, BookLevel, BtcMarket } from "./types.js";

/**
 * Deterministic, seedable market simulator. It produces synthetic BTC
 * threshold markets and order books with controllable mispricings so the full
 * scan → strategy → risk → ledger pipeline can be exercised — and its
 * profitability measured — without any live endpoint.
 *
 * The books are generated around a "fair" probability and then, with some
 * probability, dislocated into a genuine arbitrage (asks summing below $1,
 * cross-strike inversion, or bids summing above $1) so the scanner has real
 * edge to capture. Every dislocation is riskless by construction, so the
 * ledger's locked profit is a true lower bound on what the strategies extract.
 */
export class Mulberry32 {
	private a: number;
	constructor(seed: number) {
		this.a = seed >>> 0;
	}
	next(): number {
		this.a |= 0;
		this.a = (this.a + 0x6d2b79f5) | 0;
		let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	range(lo: number, hi: number): number {
		return lo + (hi - lo) * this.next();
	}
	int(lo: number, hi: number): number {
		return Math.floor(this.range(lo, hi + 1));
	}
}

export interface SimConfig {
	seed: number;
	/** Number of strike markets in the "above $K" family per round. */
	familySize: number;
	/** Probability a market's YES+NO asks are dislocated below $1. */
	pairArbProb: number;
	/** Probability a market's YES+NO bids are dislocated above $1. */
	mintSellProb: number;
	/** Probability the strike family is made non-monotone (cross-strike arb). */
	crossStrikeProb: number;
	feeRateBps: number;
}

export const DEFAULT_SIM: SimConfig = {
	seed: 1,
	familySize: 5,
	pairArbProb: 0.15,
	mintSellProb: 0.1,
	crossStrikeProb: 0.2,
	feeRateBps: 0,
};

function levels(top: number, count: number, step: number, sizeRng: () => number): BookLevel[] {
	const out: BookLevel[] = [];
	for (let i = 0; i < count; i++) {
		const price = top + i * step;
		if (price <= 0.001 || price >= 0.999) break;
		out.push({ price: Number(price.toFixed(3)), size: Math.round(sizeRng()) });
	}
	return out;
}

/** Build a two-sided book for one outcome priced around `fair`. */
function bookForOutcome(
	fair: number,
	rng: Mulberry32,
	feeBps: number,
	overrides?: { bestAsk?: number; bestBid?: number; depth?: [number, number] },
): { asks: BookLevel[]; bids: BookLevel[] } {
	const halfSpread = rng.range(0.005, 0.02);
	const bestAsk = overrides?.bestAsk ?? Math.min(0.99, fair + halfSpread);
	const bestBid = overrides?.bestBid ?? Math.max(0.01, fair - halfSpread);
	const [lo, hi] = overrides?.depth ?? [50, 400];
	const size = () => rng.range(lo, hi);
	const rawAsks = levels(bestAsk, 5, 0.01, size);
	const rawBids = levels(bestBid, 5, -0.01, size);
	return {
		asks: feeAdjustAsks(rawAsks, feeBps),
		bids: feeAdjustBids(rawBids, feeBps),
	};
}

export interface SimRound {
	markets: BtcMarket[];
	legs: Map<string, ArbLeg>;
	/** Ground-truth count of dislocations injected this round, by kind. */
	injected: { pair: number; mintSell: number; crossStrike: number };
}

let tokenCounter = 1;
function nextToken(): string {
	return `sim-${tokenCounter++}`;
}

/** Generate one round of synthetic markets + legs. */
export function generateRound(cfg: SimConfig, rng: Mulberry32, roundId: number): SimRound {
	const markets: BtcMarket[] = [];
	const legs = new Map<string, ArbLeg>();
	const injected = { pair: 0, mintSell: 0, crossStrike: 0 };
	const endDateIso = `2026-06-${10 + (roundId % 18)}T00:00:00Z`;

	// Strikes ascending; fair P(BTC > K) decreasing in K — a monotone family.
	const baseStrike = 100_000;
	const fairs: number[] = [];
	for (let i = 0; i < cfg.familySize; i++) {
		fairs.push(Math.max(0.05, 0.85 - i * 0.15 + rng.range(-0.03, 0.03)));
	}

	const makeCrossStrike = rng.next() < cfg.crossStrikeProb && cfg.familySize >= 2;
	// Inverting one adjacent pair of fairs creates a monotonicity violation the
	// cross-strike strategy can capture (cheap YES at high strike vs NO at low).
	let invertAt = -1;
	if (makeCrossStrike) {
		invertAt = rng.int(0, cfg.familySize - 2);
		const tmp = fairs[invertAt]!;
		fairs[invertAt] = fairs[invertAt + 1]! - 0.08;
		fairs[invertAt + 1] = tmp + 0.08;
		injected.crossStrike++;
	}

	for (let i = 0; i < cfg.familySize; i++) {
		const strike = baseStrike + i * 10_000;
		const fairYes = Math.max(0.05, Math.min(0.95, fairs[i]!));
		const yesTokenId = nextToken();
		const noTokenId = nextToken();
		const question = `Will Bitcoin be above $${strike.toLocaleString("en-US")} on June 13?`;

		let yesBook = bookForOutcome(fairYes, rng, cfg.feeRateBps);
		let noBook = bookForOutcome(1 - fairYes, rng, cfg.feeRateBps);

		// Inject a same-market pair arb: drive both asks down so YES+NO < $1.
		// Mirror real depth/edge structure: deep liquidity sits near fair value
		// (thin edge), while large dislocations hide in thin books (fat edge).
		if (rng.next() < cfg.pairArbProb) {
			const thin = rng.next() < 0.5;
			// thin book → aggressive (cheap) asks, high edge; deep book → barely-sub-$1.
			const sum = thin ? rng.range(0.78, 0.9) : rng.range(0.965, 0.99);
			const depth: [number, number] = thin ? [5, 30] : [200, 500];
			const yAsk = sum / 2 + rng.range(-0.05, 0.05);
			const nAsk = sum - yAsk;
			yesBook = bookForOutcome(fairYes, rng, cfg.feeRateBps, {
				bestAsk: Number(yAsk.toFixed(2)),
				depth,
			});
			noBook = bookForOutcome(1 - fairYes, rng, cfg.feeRateBps, {
				bestAsk: Number(nAsk.toFixed(2)),
				depth,
			});
			injected.pair++;
		} else if (rng.next() < cfg.mintSellProb) {
			// Inject a mint-sell: drive both bids up so YES+NO bids > $1.
			const yBid = rng.range(0.52, 0.62);
			const nBid = rng.range(0.45, 1.04 - yBid);
			yesBook = bookForOutcome(fairYes, rng, cfg.feeRateBps, { bestBid: Number(yBid.toFixed(2)) });
			noBook = bookForOutcome(1 - fairYes, rng, cfg.feeRateBps, { bestBid: Number(nBid.toFixed(2)) });
			injected.mintSell++;
		}

		const market: BtcMarket = {
			question,
			conditionId: `sim-cond-${roundId}-${i}`,
			slug: `sim-${roundId}-${i}`,
			endDateIso,
			yesTokenId,
			noTokenId,
			negRisk: false,
			eventId: `sim-event-${roundId}`,
			eventTitle: "Simulated BTC strikes",
		};
		markets.push(market);

		legs.set(yesTokenId, {
			tokenId: yesTokenId,
			marketQuestion: question,
			outcome: "Yes",
			asks: yesBook.asks,
			bids: yesBook.bids,
			tickSize: "0.01",
			negRisk: false,
		});
		legs.set(noTokenId, {
			tokenId: noTokenId,
			marketQuestion: question,
			outcome: "No",
			asks: noBook.asks,
			bids: noBook.bids,
			tickSize: "0.01",
			negRisk: false,
		});
	}

	return { markets, legs, injected };
}
