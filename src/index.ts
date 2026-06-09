import { type ApiKeyCreds, Chain, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { BookFetcher } from "./books.js";
import { type Config, loadConfig } from "./config.js";
import { DryRunExecutor, type Executor, LiveExecutor } from "./executor.js";
import { discoverBtcMarkets } from "./gamma.js";
import { RiskManager } from "./risk.js";
import { findAllArbs } from "./strategies.js";
import type { BtcMarket } from "./types.js";

const MARKET_REFRESH_MS = 10 * 60 * 1000;

async function buildClients(cfg: Config): Promise<{ client: ClobClient; executor: Executor }> {
	const chainId = cfg.chainId as Chain;

	if (!cfg.live) {
		const client = new ClobClient({ host: cfg.clobApiUrl, chain: chainId });
		return { client, executor: new DryRunExecutor() };
	}

	if (!cfg.privateKey) throw new Error("LIVE=1 requires PK to be set");
	const account = privateKeyToAccount(cfg.privateKey as `0x${string}`);
	const chain = chainId === Chain.POLYGON ? polygon : polygonAmoy;
	const signer = createWalletClient({ account, chain, transport: http() });

	let creds: ApiKeyCreds | undefined;
	if (cfg.clobApiKey && cfg.clobSecret && cfg.clobPassphrase) {
		creds = { key: cfg.clobApiKey, secret: cfg.clobSecret, passphrase: cfg.clobPassphrase };
	}
	let client = new ClobClient({ host: cfg.clobApiUrl, chain: chainId, signer, creds });
	if (!creds) {
		console.log("no CLOB API creds in env, deriving from wallet...");
		creds = await client.createOrDeriveApiKey();
		client = new ClobClient({ host: cfg.clobApiUrl, chain: chainId, signer, creds });
	}
	console.log(`LIVE trading as ${account.address}`);
	return { client, executor: new LiveExecutor(client) };
}

async function scanOnce(
	cfg: Config,
	markets: BtcMarket[],
	books: BookFetcher,
	risk: RiskManager,
	executor: Executor,
): Promise<void> {
	const legs = await books.fetchLegs(markets);
	const opportunities = findAllArbs({
		markets,
		legs,
		minEdge: cfg.minEdge,
		maxUsdPerTrade: cfg.maxUsdPerTrade,
	});

	if (opportunities.length === 0) {
		console.log(`no arbs >= ${(cfg.minEdge * 100).toFixed(1)}% edge across ${markets.length} markets`);
		return;
	}

	for (const opp of opportunities) {
		const rejection = risk.check(opp);
		if (rejection) {
			console.log(`skip [${opp.kind}] ${opp.description}: ${rejection}`);
			continue;
		}
		const result = await executor.execute(opp);
		if (result.spentUsd > 0) risk.recordSpend(result.spentUsd);
		// Books are stale for overlapping opportunities once one trade fires.
		if (result.executed) break;
	}
}

async function main() {
	const cfg = loadConfig();
	const once = process.argv.includes("--once");
	console.log(
		`polymarket btc arb | mode=${cfg.live ? "LIVE" : "dry-run"} minEdge=${cfg.minEdge} ` +
			`maxPerTrade=$${cfg.maxUsdPerTrade} maxDaily=$${cfg.maxDailyUsd}`,
	);

	const { client, executor } = await buildClients(cfg);
	const books = new BookFetcher(client);
	const risk = new RiskManager(cfg.maxDailyUsd, cfg.minProfitUsd);

	let markets: BtcMarket[] = [];
	let marketsFetchedAt = 0;

	do {
		try {
			if (Date.now() - marketsFetchedAt > MARKET_REFRESH_MS) {
				markets = await discoverBtcMarkets(cfg);
				marketsFetchedAt = Date.now();
				console.log(`tracking ${markets.length} bitcoin markets`);
			}
			await scanOnce(cfg, markets, books, risk, executor);
		} catch (err) {
			console.error(`scan failed: ${(err as Error).message}`);
		}
		if (!once) await new Promise((r) => setTimeout(r, cfg.scanIntervalMs));
	} while (!once);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
