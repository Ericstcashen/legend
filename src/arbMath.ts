import type { ArbLeg, ArbPlanLeg, BookLevel } from "./types.js";

/**
 * Polymarket taker fees are charged symmetrically: fee = rate * min(p, 1-p) * shares.
 * Returns ask levels with the fee folded into the price so downstream math can
 * treat cost as price * shares.
 */
export function feeAdjustAsks(asks: BookLevel[], feeRateBps: number): BookLevel[] {
	if (feeRateBps <= 0) return asks;
	const rate = feeRateBps / 10_000;
	return asks.map(({ price, size }) => ({
		price: price + rate * Math.min(price, 1 - price),
		size,
	}));
}

export interface JointFill {
	shares: number;
	totalCost: number;
	perLeg: { shares: number; cost: number; capPrice: number }[];
}

/**
 * Buy the same number of shares on every leg simultaneously, walking each
 * leg's ask levels best-first, for as long as the marginal combined price of
 * one share-set stays at or below maxSetCost. Stops early once shares reach
 * maxShares.
 */
export function jointFill(legAsks: BookLevel[][], maxSetCost: number, maxShares = Infinity): JointFill {
	const idx = legAsks.map(() => 0);
	const taken = legAsks.map(() => 0); // shares consumed at current level
	const perLeg = legAsks.map(() => ({ shares: 0, cost: 0, capPrice: 0 }));
	let shares = 0;
	let totalCost = 0;

	for (;;) {
		if (shares >= maxShares) break;

		// Marginal price of the next share-set and room left at current levels.
		let marginal = 0;
		let room = maxShares - shares;
		let exhausted = false;
		for (let i = 0; i < legAsks.length; i++) {
			const level = legAsks[i]![idx[i]!];
			if (!level) {
				exhausted = true;
				break;
			}
			marginal += level.price;
			room = Math.min(room, level.size - taken[i]!);
		}
		if (exhausted || marginal > maxSetCost + 1e-12 || room <= 1e-9) break;

		shares += room;
		totalCost += marginal * room;
		for (let i = 0; i < legAsks.length; i++) {
			const level = legAsks[i]![idx[i]!]!;
			perLeg[i]!.shares += room;
			perLeg[i]!.cost += level.price * room;
			perLeg[i]!.capPrice = Math.max(perLeg[i]!.capPrice, level.price);
			taken[i]! += room;
			if (level.size - taken[i]! <= 1e-9) {
				idx[i]!++;
				taken[i] = 0;
			}
		}
	}

	return { shares, totalCost, perLeg };
}

/**
 * Plan a buy-all-legs arbitrage where each share-set redeems for
 * guaranteedValuePerSet at resolution. Returns null when no size clears
 * the required edge.
 */
export function planArb(
	legs: ArbLeg[],
	guaranteedValuePerSet: number,
	minEdge: number,
	maxUsd: number,
): { legs: ArbPlanLeg[]; shares: number; totalCost: number; profit: number; edge: number } | null {
	const maxSetCost = guaranteedValuePerSet * (1 - minEdge);
	// First pass unbounded to learn the average set cost, then cap by budget.
	const probe = jointFill(legs.map((l) => l.asks), maxSetCost);
	if (probe.shares <= 0) return null;

	const avgSetCost = probe.totalCost / probe.shares;
	const maxShares = maxUsd / avgSetCost;
	const fill = probe.totalCost <= maxUsd ? probe : jointFill(legs.map((l) => l.asks), maxSetCost, maxShares);
	if (fill.shares <= 0) return null;

	const profit = guaranteedValuePerSet * fill.shares - fill.totalCost;
	return {
		legs: legs.map((leg, i) => ({
			leg,
			shares: fill.perLeg[i]!.shares,
			cost: fill.perLeg[i]!.cost,
			capPrice: fill.perLeg[i]!.capPrice,
		})),
		shares: fill.shares,
		totalCost: fill.totalCost,
		profit,
		edge: profit / fill.totalCost,
	};
}
