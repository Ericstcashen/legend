import { config as dotenvConfig } from "dotenv";

dotenvConfig({ quiet: true });

function num(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const v = Number(raw);
	if (!Number.isFinite(v)) throw new Error(`env ${name} is not a number: ${raw}`);
	return v;
}

function bool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return raw === "1" || raw.toLowerCase() === "true";
}

export interface Config {
	gammaApiUrl: string;
	clobApiUrl: string;
	chainId: number;
	/** Gamma event tag slugs to scan, in addition to keyword matching. */
	tagSlugs: string[];
	/** Case-insensitive keywords a market question must contain. */
	keywords: string[];
	/** Max Gamma pages (500 markets each) to scan when keyword searching. */
	maxGammaPages: number;

	/** Minimum edge per $1 redemption, after fees (0.01 = 1%). */
	minEdge: number;
	/** Skip opportunities whose total profit is below this. */
	minProfitUsd: number;
	maxUsdPerTrade: number;
	maxDailyUsd: number;
	scanIntervalMs: number;

	/** Re-act on the same opportunity at most once per window. */
	cooldownMs: number;
	/** JSONL file where paper (dry-run) fills are recorded. */
	paperLedgerPath: string;

	/** When false (default) opportunities are logged, never traded. */
	live: boolean;
	/** When true, the live executor refuses to place any order. */
	killSwitch: boolean;
	privateKey?: string;
	clobApiKey?: string;
	clobSecret?: string;
	clobPassphrase?: string;
}

export function loadConfig(): Config {
	return {
		gammaApiUrl: process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
		clobApiUrl: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
		chainId: num("CHAIN_ID", 137),
		tagSlugs: (process.env.TAG_SLUGS ?? "bitcoin").split(",").filter(Boolean),
		keywords: (process.env.KEYWORDS ?? "bitcoin,btc").split(",").filter(Boolean),
		maxGammaPages: num("MAX_GAMMA_PAGES", 4),

		minEdge: num("MIN_EDGE", 0.01),
		minProfitUsd: num("MIN_PROFIT_USD", 0.25),
		maxUsdPerTrade: num("MAX_USD_PER_TRADE", 100),
		maxDailyUsd: num("MAX_DAILY_USD", 500),
		scanIntervalMs: num("SCAN_INTERVAL_MS", 15_000),

		cooldownMs: num("COOLDOWN_MS", 10 * 60 * 1000),
		paperLedgerPath: process.env.PAPER_LEDGER ?? "data/paper-trades.jsonl",

		live: bool("LIVE", false),
		killSwitch: bool("KILL_SWITCH", false),
		privateKey: process.env.PK,
		clobApiKey: process.env.CLOB_API_KEY,
		clobSecret: process.env.CLOB_SECRET,
		clobPassphrase: process.env.CLOB_PASS_PHRASE,
	};
}
