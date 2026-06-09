export interface BookLevel {
	price: number;
	size: number;
}

/** One side of one market's orderbook, fee-adjusted, ready for the joint walk. */
export interface ArbLeg {
	tokenId: string;
	marketQuestion: string;
	outcome: string;
	/** Ask levels sorted best (lowest) first, prices fee-adjusted upward. */
	asks: BookLevel[];
	/** Bid levels sorted best (highest) first, prices fee-adjusted downward (net proceeds). */
	bids: BookLevel[];
	tickSize: string;
	negRisk: boolean;
}

export interface ArbPlanLeg {
	leg: ArbLeg;
	shares: number;
	/** Dollars spent (buys) or received (sells) on this leg, fee-adjusted. */
	cost: number;
	/** Worst level price touched: highest for buys, lowest for sells. */
	capPrice: number;
}

export interface ArbOpportunity {
	kind: "pair" | "cross-strike" | "neg-risk-yes" | "neg-risk-no" | "mint-sell";
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
	/**
	 * False when the basket needs an on-chain step the executor does not
	 * automate (e.g. CTF split before selling); such finds are reported, not traded.
	 */
	executable: boolean;
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
