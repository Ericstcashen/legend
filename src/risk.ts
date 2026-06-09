import type { ArbOpportunity } from "./types.js";

/** Tracks spend against the daily budget; resets at UTC midnight. */
export class RiskManager {
	private spentToday = 0;
	private day = new Date().toISOString().slice(0, 10);

	constructor(
		private maxDailyUsd: number,
		private minProfitUsd: number,
	) {}

	private rollover(): void {
		const today = new Date().toISOString().slice(0, 10);
		if (today !== this.day) {
			this.day = today;
			this.spentToday = 0;
		}
	}

	/** Returns a rejection reason, or null when the trade may proceed. */
	check(opp: ArbOpportunity): string | null {
		this.rollover();
		if (opp.profit < this.minProfitUsd) {
			return `profit $${opp.profit.toFixed(2)} below minimum $${this.minProfitUsd}`;
		}
		if (this.spentToday + opp.totalCost > this.maxDailyUsd) {
			return `daily budget exhausted ($${this.spentToday.toFixed(2)}/$${this.maxDailyUsd} spent)`;
		}
		return null;
	}

	recordSpend(usd: number): void {
		this.rollover();
		this.spentToday += usd;
	}
}
