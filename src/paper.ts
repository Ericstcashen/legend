import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArbOpportunity } from "./types.js";

export interface PaperTrade {
	ts: string;
	kind: ArbOpportunity["kind"];
	description: string;
	shares: number;
	totalCost: number;
	guaranteedValue: number;
	profit: number;
	edge: number;
	legs: { tokenId: string; outcome: string; shares: number; cost: number; capPrice: number }[];
}

/**
 * Append-only JSONL ledger of paper fills. Every recorded trade's profit is
 * locked in at fill time (the baskets are riskless at resolution), so the
 * running total is the bot's realizable P&L, not a mark-to-market estimate.
 */
export class PaperLedger {
	private trades = 0;
	private costBasis = 0;
	private lockedProfit = 0;

	constructor(private path: string) {
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const t = JSON.parse(line) as PaperTrade;
				this.trades++;
				this.costBasis += t.totalCost;
				this.lockedProfit += t.profit;
			} catch {
				// Skip corrupt lines rather than losing the whole ledger.
			}
		}
	}

	record(opp: ArbOpportunity): void {
		const trade: PaperTrade = {
			ts: new Date().toISOString(),
			kind: opp.kind,
			description: opp.description,
			shares: opp.shares,
			totalCost: opp.totalCost,
			guaranteedValue: opp.guaranteedValue,
			profit: opp.profit,
			edge: opp.edge,
			legs: opp.legs.map((l) => ({
				tokenId: l.leg.tokenId,
				outcome: l.leg.outcome,
				shares: l.shares,
				cost: l.cost,
				capPrice: l.capPrice,
			})),
		};
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(trade)}\n`);
		this.trades++;
		this.costBasis += trade.totalCost;
		this.lockedProfit += trade.profit;
	}

	summary(): string {
		if (this.trades === 0) return "paper P&L: no fills yet";
		const roi = this.costBasis > 0 ? (this.lockedProfit / this.costBasis) * 100 : 0;
		return (
			`paper P&L: ${this.trades} fills, $${this.costBasis.toFixed(2)} deployed, ` +
			`$${this.lockedProfit.toFixed(2)} locked profit (${roi.toFixed(2)}% on capital)`
		);
	}

	get stats(): { trades: number; costBasis: number; lockedProfit: number } {
		return { trades: this.trades, costBasis: this.costBasis, lockedProfit: this.lockedProfit };
	}
}
