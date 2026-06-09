export interface BookLevel {
	price: number;
	size: number;
}

/** One side of one market's orderbook, fee-adjusted, ready for the joint walk. */
export interface ArbLeg {
	tokenId: string;
	marketQuestion: string;
	outcome: string;
	/** Ask levels sorted best (lowest) first, prices fee-adjusted. */
	asks: BookLevel[];
	tickSize: string;
	negRisk: boolean;
}

export interface ArbPlanLeg {
	leg: ArbLeg;
	shares: number;
	/** Dollars spent on this leg (fee-adjusted). */
	cost: number;
	/** Worst (highest) level price touched; used as the FOK price cap. */
	capPrice: number;
}

export interface ArbOpportunity {
	kind: "pair" | "cross-strike" | "neg-risk-yes" | "neg-risk-no";
	description: string;
	legs: ArbPlanLeg[];
	/** Number of $1-redemption sets purchased. */
	shares: number;
	totalCost: number;
	/** Guaranteed redemption value at resolution. */
	guaranteedValue: number;
	profit: number;
	/** profit / totalCost */
	edge: number;
}

export interface BtcMarket {
	question: string;
	conditionId: string;
	slug: string;
	endDateIso?: string;
	yesTokenId: string;
	noTokenId: string;
	negRisk: boolean;
	eventId?: string;
	eventTitle?: string;
	bestAskYes?: number;
	bestAskNo?: number;
}
