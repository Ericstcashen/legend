import type { ArbOpportunity } from "./types.js";

/**
 * Remembers recently acted-on opportunities so a standing arb is not
 * re-counted (paper) or re-fired (live) every scan while the books are
 * unchanged. Keyed by strategy kind plus the sorted leg token ids.
 */
export class Cooldown {
	private seen = new Map<string, number>();

	constructor(private windowMs: number) {}

	static key(opp: ArbOpportunity): string {
		const tokens = opp.legs.map((l) => l.leg.tokenId).sort();
		return `${opp.kind}|${tokens.join(",")}`;
	}

	/** True when the opportunity was acted on within the window. */
	active(opp: ArbOpportunity, now = Date.now()): boolean {
		const at = this.seen.get(Cooldown.key(opp));
		return at !== undefined && now - at < this.windowMs;
	}

	mark(opp: ArbOpportunity, now = Date.now()): void {
		this.seen.set(Cooldown.key(opp), now);
		// Bounded cleanup so the map cannot grow without limit.
		if (this.seen.size > 10_000) {
			for (const [k, at] of this.seen) {
				if (now - at >= this.windowMs) this.seen.delete(k);
			}
		}
	}
}

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
