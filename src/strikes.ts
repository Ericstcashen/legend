import type { BtcMarket } from "./types.js";

export type StrikeDirection = "up" | "down";

export interface StrikeInfo {
	strike: number;
	direction: StrikeDirection;
	/** Question with the strike replaced by {K}; used to group comparable markets. */
	familyKey: string;
}

const MONEY_RE = /\$\s?([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?/;

const UP_WORDS = /\b(above|reach|hit|exceed|at least|higher than|greater than|or more)\b/i;
const UP_PLUS = /\$\s?[\d][\d,]*(?:\.\d+)?\s*[kKmM]?\+/; // "$110K+" style titles
const DOWN_WORDS = /\b(below|under|dip to|drop to|fall to|less than|lower than|or less)\b/i;

/**
 * Extract the dollar strike and direction from a bitcoin market question like
 * "Will Bitcoin be above $110,000 on June 13?" or "Will Bitcoin reach $150K by 2026?".
 * Returns null when the question has no single unambiguous strike.
 */
export function parseStrike(question: string): StrikeInfo | null {
	const matches = [...question.matchAll(new RegExp(MONEY_RE, "g"))];
	if (matches.length !== 1) return null; // ranges ("between $X and $Y") are not threshold markets
	const m = matches[0]!;

	let strike = Number(m[1]!.replaceAll(",", ""));
	const suffix = m[2]?.toLowerCase();
	if (suffix === "k") strike *= 1_000;
	if (suffix === "m") strike *= 1_000_000;
	if (!Number.isFinite(strike) || strike <= 0) return null;

	const up = UP_WORDS.test(question) || UP_PLUS.test(question);
	const down = DOWN_WORDS.test(question);
	if (up === down) return null; // ambiguous or undirected ("be exactly $X")

	const familyKey = question
		.replace(new RegExp(MONEY_RE, "g"), "{K}")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();

	return { strike, direction: up ? "up" : "down", familyKey };
}

export interface StrikeFamily {
	familyKey: string;
	direction: StrikeDirection;
	endDateIso?: string;
	/** Sorted by strike ascending. */
	markets: { market: BtcMarket; strike: number }[];
}

/**
 * Group threshold markets into families that differ only by strike (same
 * question template, direction and end date), so monotonicity arbs only
 * compare like with like.
 */
export function groupStrikeFamilies(markets: BtcMarket[]): StrikeFamily[] {
	const families = new Map<string, StrikeFamily>();
	for (const market of markets) {
		const info = parseStrike(market.question);
		if (!info) continue;
		const key = `${info.familyKey}|${info.direction}|${market.endDateIso ?? ""}`;
		let family = families.get(key);
		if (!family) {
			family = {
				familyKey: info.familyKey,
				direction: info.direction,
				endDateIso: market.endDateIso,
				markets: [],
			};
			families.set(key, family);
		}
		family.markets.push({ market, strike: info.strike });
	}

	const result = [...families.values()].filter((f) => f.markets.length >= 2);
	for (const f of result) f.markets.sort((a, b) => a.strike - b.strike);
	return result;
}

/**
 * Cross-strike pairs whose combined YES+NO basket redeems for at least $1.
 *
 * For an "up" family (P(BTC > K)), winning is easier at the lower strike:
 * YES(lowK) + NO(highK) pays 1 outside (lowK, highK] and 2 inside.
 * For a "down" family (P(BTC < K)) it is the reverse: YES(highK) + NO(lowK).
 */
export function crossStrikePairs(
	family: StrikeFamily,
): { yesMarket: BtcMarket; noMarket: BtcMarket; yesStrike: number; noStrike: number }[] {
	const pairs: { yesMarket: BtcMarket; noMarket: BtcMarket; yesStrike: number; noStrike: number }[] = [];
	for (let i = 0; i < family.markets.length; i++) {
		for (let j = i + 1; j < family.markets.length; j++) {
			const low = family.markets[i]!;
			const high = family.markets[j]!;
			if (low.strike === high.strike) continue;
			const [easy, hard] = family.direction === "up" ? [low, high] : [high, low];
			pairs.push({
				yesMarket: easy.market,
				noMarket: hard.market,
				yesStrike: easy.strike,
				noStrike: hard.strike,
			});
		}
	}
	return pairs;
}
