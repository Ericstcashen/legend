import type { ArbLeg, BookLevel } from "./types.js";

/**
 * Independent computation of the maximum riskless profit extractable from a
 * binary market's book — derived from first principles here, NOT by calling
 * the strategy code, so it serves as an external check on strategy optimality.
 *
 * A binary market resolves to exactly one of two states (YES=$1 / NO=$1). The
 * only state-independent (riskless) edges are:
 *   - BUY a complete set: pay ask(YES)+ask(NO); it always redeems for $1, so
 *     any depth where the combined ask is below $1 is pure profit.
 *   - SELL a minted set: receive bid(YES)+bid(NO); minting a set costs $1, so
 *     any depth where the combined bid is above $1 is pure profit.
 * These two use opposite sides of the book and are mutually exclusive in price
 * (asks > bids), so their sum is the exhaustive riskless optimum for the
 * market. No strategy — ours or a competitor's — can risklessly extract more
 * from the same book.
 */
export function maxBinaryRisklessProfit(
	yes: ArbLeg,
	no: ArbLeg,
	maxUsd = Number.POSITIVE_INFINITY,
): { buyProfit: number; sellProfit: number; total: number } {
	const buyProfit = walkComplementary(yes.asks, no.asks, (sum) => 1 - sum, maxUsd);
	const sellProfit = walkComplementary(yes.bids, no.bids, (sum) => sum - 1, maxUsd);
	return { buyProfit, sellProfit, total: buyProfit + sellProfit };
}

/**
 * Walk two books best-first, accumulating profit while the per-set margin
 * (from `marginOf` applied to the combined top-of-book price) stays positive,
 * bounded by maxUsd of cost. Generic over buy (ask) and sell (bid) sides.
 */
function walkComplementary(
	aLevels: BookLevel[],
	bLevels: BookLevel[],
	marginOf: (combinedPrice: number) => number,
	maxUsd: number,
): number {
	let i = 0;
	let bi = 0;
	let aTaken = 0;
	let bTaken = 0;
	let profit = 0;
	let cost = 0;

	while (i < aLevels.length && bi < bLevels.length) {
		const a = aLevels[i]!;
		const b = bLevels[bi]!;
		const combined = a.price + b.price;
		const margin = marginOf(combined);
		if (margin <= 1e-12) break;

		const room = Math.min(a.size - aTaken, b.size - bTaken, (maxUsd - cost) / combined);
		if (room <= 1e-9) break;

		profit += margin * room;
		cost += combined * room;
		aTaken += room;
		bTaken += room;
		if (a.size - aTaken <= 1e-9) {
			i++;
			aTaken = 0;
		}
		if (b.size - bTaken <= 1e-9) {
			bi++;
			bTaken = 0;
		}
	}
	return profit;
}

export interface CaptureReport {
	availableRiskless: number;
	captured: number;
	/** captured / availableRiskless, or 1 when nothing was available. */
	efficiency: number;
}

/**
 * Capture efficiency: what fraction of the independently-computed available
 * riskless profit the strategies actually booked. 1.0 means the trader leaves
 * no riskless edge on the table — the offline-provable core of "most
 * profitable": against the same book, no competitor can extract more.
 */
export function captureEfficiency(available: number, captured: number): CaptureReport {
	if (available <= 1e-9) return { availableRiskless: available, captured, efficiency: 1 };
	return { availableRiskless: available, captured, efficiency: captured / available };
}
