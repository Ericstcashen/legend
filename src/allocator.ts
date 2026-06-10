import type { ArbOpportunity } from "./types.js";

/**
 * Choose which opportunities to fund when capital is limited.
 *
 * Each basket is riskless and already sized to its per-trade cap, so this is a
 * 0/1 knapsack: maximize total profit subject to total cost <= budget. When
 * the budget binds, the profit-maximizing order is by edge (profit per dollar)
 * descending, not absolute profit — a $0.50 profit on $5 beats $0.60 on $90
 * per dollar deployed. Greedy-by-edge is optimal for the fractional relaxation
 * and near-optimal here because baskets are small relative to the bankroll.
 *
 * Overlapping legs are de-duplicated: once a token is committed in one basket,
 * later baskets touching the same token are skipped, since funding both would
 * double-count depth that a single fill consumes.
 */
export function allocate(
	opportunities: ArbOpportunity[],
	budget: number,
): { chosen: ArbOpportunity[]; spend: number; profit: number } {
	const ranked = [...opportunities].sort((a, b) => b.edge - a.edge);
	const usedTokens = new Set<string>();
	const chosen: ArbOpportunity[] = [];
	let spend = 0;
	let profit = 0;

	for (const opp of ranked) {
		if (spend + opp.totalCost > budget + 1e-9) continue;
		if (opp.legs.some((l) => usedTokens.has(l.leg.tokenId))) continue;
		chosen.push(opp);
		for (const l of opp.legs) usedTokens.add(l.leg.tokenId);
		spend += opp.totalCost;
		profit += opp.profit;
	}

	return { chosen, spend, profit };
}

/**
 * Bankroll guard with an EMA-smoothed equity circuit breaker, modeled on
 * polybot's risk controls. Trading halts when smoothed equity falls a set
 * fraction below its running peak, protecting capital during a drawdown
 * (e.g. a string of legs that failed to fully hedge). Resets when equity
 * recovers above the trip level.
 */
export class Bankroll {
	private equity: number;
	private peak: number;
	private tripped = false;

	constructor(
		private startingEquity: number,
		/** Fraction below peak that trips the breaker, e.g. 0.1 = 10% drawdown. */
		private maxDrawdown = 0.1,
		/** EMA smoothing factor for equity updates. */
		private alpha = 0.3,
	) {
		this.equity = startingEquity;
		this.peak = startingEquity;
	}

	/** Fold a realized P&L delta into smoothed equity and update the breaker. */
	update(realizedDelta: number): void {
		this.equity = this.alpha * (this.equity + realizedDelta) + (1 - this.alpha) * this.equity;
		if (this.equity > this.peak) this.peak = this.equity;
		const drawdown = this.peak > 0 ? (this.peak - this.equity) / this.peak : 0;
		if (drawdown >= this.maxDrawdown) this.tripped = true;
		else if (drawdown < this.maxDrawdown * 0.5) this.tripped = false; // hysteresis
	}

	/** True when trading should be halted. */
	get halted(): boolean {
		return this.tripped;
	}

	summary(): string {
		const dd = this.peak > 0 ? ((this.peak - this.equity) / this.peak) * 100 : 0;
		return `equity $${this.equity.toFixed(2)} (peak $${this.peak.toFixed(2)}, dd ${dd.toFixed(1)}%)${
			this.tripped ? " HALTED" : ""
		}`;
	}
}
