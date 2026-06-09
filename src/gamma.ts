import type { Config } from "./config.js";
import type { BtcMarket } from "./types.js";

interface GammaMarket {
	question?: string;
	conditionId?: string;
	slug?: string;
	endDate?: string;
	clobTokenIds?: string; // JSON-encoded string array
	outcomes?: string; // JSON-encoded string array, e.g. '["Yes","No"]'
	negRisk?: boolean;
	active?: boolean;
	closed?: boolean;
	enableOrderBook?: boolean;
	events?: { id?: string; title?: string; negRisk?: boolean }[];
}

interface GammaEvent {
	id?: string;
	title?: string;
	negRisk?: boolean;
	closed?: boolean;
	markets?: GammaMarket[];
}

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`gamma ${res.status} for ${url}`);
	return (await res.json()) as T;
}

function toBtcMarket(m: GammaMarket, event?: { id?: string; title?: string }): BtcMarket | null {
	if (!m.question || !m.conditionId || !m.clobTokenIds) return null;
	if (m.closed || m.active === false || m.enableOrderBook === false) return null;

	let tokenIds: string[];
	let outcomes: string[];
	try {
		tokenIds = JSON.parse(m.clobTokenIds);
		outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Yes", "No"];
	} catch {
		return null;
	}
	if (tokenIds.length !== 2) return null;

	// Token order follows the outcomes array; make sure index 0 is really Yes.
	const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
	const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
	if (yesIdx === -1 || noIdx === -1) return null;

	const ev = event ?? m.events?.[0];
	return {
		question: m.question,
		conditionId: m.conditionId,
		slug: m.slug ?? "",
		endDateIso: m.endDate,
		yesTokenId: tokenIds[yesIdx]!,
		noTokenId: tokenIds[noIdx]!,
		negRisk: Boolean(m.negRisk),
		eventId: ev?.id,
		eventTitle: ev?.title,
	};
}

function matchesKeywords(question: string, keywords: string[]): boolean {
	const q = question.toLowerCase();
	return keywords.some((k) => new RegExp(`\\b${k.trim().toLowerCase()}\\b`, "i").test(q));
}

/**
 * Discover open bitcoin markets via the Gamma API: every market under the
 * configured tag slugs, plus keyword matches from the most active markets.
 */
export async function discoverBtcMarkets(cfg: Config): Promise<BtcMarket[]> {
	const found = new Map<string, BtcMarket>();

	for (const tag of cfg.tagSlugs) {
		try {
			const events = await getJson<GammaEvent[]>(
				`${cfg.gammaApiUrl}/events?tag_slug=${encodeURIComponent(tag)}&closed=false&limit=100`,
			);
			for (const ev of events) {
				for (const gm of ev.markets ?? []) {
					const market = toBtcMarket(gm, ev);
					if (market) found.set(market.conditionId, market);
				}
			}
		} catch (err) {
			console.warn(`tag scan failed for "${tag}": ${(err as Error).message}`);
		}
	}

	const pageSize = 500;
	for (let page = 0; page < cfg.maxGammaPages; page++) {
		let markets: GammaMarket[];
		try {
			markets = await getJson<GammaMarket[]>(
				`${cfg.gammaApiUrl}/markets?active=true&closed=false&archived=false` +
					`&order=volume24hr&ascending=false&limit=${pageSize}&offset=${page * pageSize}`,
			);
		} catch (err) {
			console.warn(`market page ${page} failed: ${(err as Error).message}`);
			break;
		}
		for (const gm of markets) {
			if (!gm.question || !matchesKeywords(gm.question, cfg.keywords)) continue;
			const market = toBtcMarket(gm);
			if (market) found.set(market.conditionId, market);
		}
		if (markets.length < pageSize) break;
	}

	return [...found.values()];
}
