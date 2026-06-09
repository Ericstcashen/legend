import { planArb, planMintSell } from "./arbMath.js";
import { crossStrikePairs, groupStrikeFamilies } from "./strikes.js";
import type { ArbLeg, ArbOpportunity, BtcMarket } from "./types.js";

interface StrategyInputs {
	markets: BtcMarket[];
	legs: Map<string, ArbLeg>;
	minEdge: number;
	maxUsdPerTrade: number;
}

function legsFor(inputs: StrategyInputs, tokenIds: string[]): ArbLeg[] | null {
	const legs: ArbLeg[] = [];
	for (const id of tokenIds) {
		const leg = inputs.legs.get(id);
		if (!leg || leg.asks.length === 0) return null;
		legs.push(leg);
	}
	return legs;
}

function build(
	kind: ArbOpportunity["kind"],
	description: string,
	legs: ArbLeg[],
	guaranteedPerSet: number,
	inputs: StrategyInputs,
): ArbOpportunity | null {
	const plan = planArb(legs, guaranteedPerSet, inputs.minEdge, inputs.maxUsdPerTrade);
	if (!plan) return null;
	return {
		kind,
		description,
		legs: plan.legs,
		shares: plan.shares,
		totalCost: plan.totalCost,
		guaranteedValue: guaranteedPerSet * plan.shares,
		profit: plan.profit,
		edge: plan.edge,
		executable: true,
	};
}

/**
 * Overpriced books: combined net YES+NO bids above $1. Capturing it means
 * splitting $1 of USDC into a YES+NO pair on-chain (CTF) and selling both.
 * The split is not automated, so these are reported rather than traded,
 * and the profit is immediate — no capital lock until resolution.
 */
export function findMintSellArbs(inputs: StrategyInputs): ArbOpportunity[] {
	const out: ArbOpportunity[] = [];
	for (const m of inputs.markets) {
		const yes = inputs.legs.get(m.yesTokenId);
		const no = inputs.legs.get(m.noTokenId);
		if (!yes?.bids.length || !no?.bids.length) continue;
		const plan = planMintSell([yes, no], inputs.minEdge, inputs.maxUsdPerTrade);
		if (!plan) continue;
		out.push({
			kind: "mint-sell",
			description: `YES+NO bids > $1 (mint & sell) | ${m.question}`,
			legs: plan.legs,
			shares: plan.shares,
			totalCost: plan.totalCost,
			guaranteedValue: plan.totalCost + plan.profit,
			profit: plan.profit,
			edge: plan.edge,
			executable: false,
		});
	}
	return out;
}

/** Same-market arb: YES ask + NO ask under $1 redeems a guaranteed dollar. */
export function findPairArbs(inputs: StrategyInputs): ArbOpportunity[] {
	const out: ArbOpportunity[] = [];
	for (const m of inputs.markets) {
		const legs = legsFor(inputs, [m.yesTokenId, m.noTokenId]);
		if (!legs) continue;
		const opp = build("pair", `YES+NO < $1 | ${m.question}`, legs, 1, inputs);
		if (opp) out.push(opp);
	}
	return out;
}

/**
 * Cross-strike monotonicity arb on BTC threshold families: the basket of the
 * easier-to-win YES and the harder-to-win NO redeems for at least $1.
 */
export function findCrossStrikeArbs(inputs: StrategyInputs): ArbOpportunity[] {
	const out: ArbOpportunity[] = [];
	for (const family of groupStrikeFamilies(inputs.markets)) {
		for (const pair of crossStrikePairs(family)) {
			const legs = legsFor(inputs, [pair.yesMarket.yesTokenId, pair.noMarket.noTokenId]);
			if (!legs) continue;
			const opp = build(
				"cross-strike",
				`YES(${pair.yesMarket.question}) + NO(${pair.noMarket.question})`,
				legs,
				1,
				inputs,
			);
			if (opp) out.push(opp);
		}
	}
	return out;
}

/**
 * Negative-risk events (mutually exclusive outcomes, exactly one resolves YES):
 *  - all YES legs redeem for exactly $1 per set;
 *  - all NO legs redeem for $(n-1) per set.
 */
export function findNegRiskArbs(inputs: StrategyInputs): ArbOpportunity[] {
	const events = new Map<string, BtcMarket[]>();
	for (const m of inputs.markets) {
		if (!m.negRisk || !m.eventId) continue;
		const list = events.get(m.eventId) ?? [];
		list.push(m);
		events.set(m.eventId, list);
	}

	const out: ArbOpportunity[] = [];
	for (const [, markets] of events) {
		if (markets.length < 2) continue;
		const title = markets[0]!.eventTitle ?? markets[0]!.question;
		const n = markets.length;

		const yesLegs = legsFor(inputs, markets.map((m) => m.yesTokenId));
		if (yesLegs) {
			const opp = build("neg-risk-yes", `all ${n} YES < $1 | ${title}`, yesLegs, 1, inputs);
			if (opp) out.push(opp);
		}

		const noLegs = legsFor(inputs, markets.map((m) => m.noTokenId));
		if (noLegs) {
			const opp = build("neg-risk-no", `all ${n} NO < $${n - 1} | ${title}`, noLegs, n - 1, inputs);
			if (opp) out.push(opp);
		}
	}
	return out;
}

export function findAllArbs(inputs: StrategyInputs): ArbOpportunity[] {
	return [
		...findPairArbs(inputs),
		...findCrossStrikeArbs(inputs),
		...findNegRiskArbs(inputs),
		...findMintSellArbs(inputs),
	].sort((a, b) => b.profit - a.profit);
}
