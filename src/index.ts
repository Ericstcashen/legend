import { existsSync } from "node:fs";
import { type ApiKeyCreds, Chain, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { BookFetcher } from "./books.js";
import { type Config, loadConfig } from "./config.js";
import { DryRunExecutor, type Executor, LiveExecutor } from "./executor.js";
import { discoverBtcMarkets } from "./gamma.js";
import { PaperLedger } from "./paper.js";
import { Cooldown, RiskManager } from "./risk.js";
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
	// Halt orders via env (KILL_SWITCH=1) or by touching a KILL file at runtime.
	const killSwitch = () => cfg.killSwitch || existsSync("KILL");
	return { client, executor: new LiveExecutor(client, killSwitch) };
}

interface ScanContext {
	cfg: Config;
	books: BookFetcher;
	risk: RiskManager;
	executor: Executor;
	cooldown: Cooldown;
	ledger: PaperLedger;
}

async function scanOnce(ctx: ScanContext, markets: BtcMarket[]): Promise<void> {
	const { cfg, books, risk, executor, cooldown, ledger } = ctx;
	const legs = await books.fetchLegs(markets);
	const opportunities = findAllArbs({
		markets,
		legs,
		minEdge: cfg.minEdge,
		maxUsdPerTrade: cfg.maxUsdPerTrade,
	});

	if (opportunities.length === 0) {
		console.log(
			`no arbs >= ${(cfg.minEdge * 100).toFixed(1)}% edge across ${markets.length} markets | ${ledger.summary()}`,
		);
		return;
	}

	for (const opp of opportunities) {
		if (cooldown.active(opp)) continue;
		const rejection = risk.check(opp);
		if (rejection) {
			console.log(`skip [${opp.kind}] ${opp.description}: ${rejection}`);
			continue;
		}

		if (!opp.executable) {
			console.log(
				`MANUAL [${opp.kind}] ${opp.description}: $${opp.profit.toFixed(2)} available ` +
					`but needs an on-chain CTF split before selling — not automated`,
			);
			cooldown.mark(opp);
			continue;
		}

		const result = await executor.execute(opp);
		if (result.spentUsd > 0) risk.recordSpend(result.spentUsd);
		if (!cfg.live) {
			// Paper fill: we sized from live depth, so book the planned basket.
			ledger.record(opp);
			risk.recordSpend(opp.totalCost);
			cooldown.mark(opp);
			continue;
		}
		if (result.executed) {
			cooldown.mark(opp);
			// Books are stale for overlapping opportunities once one trade fires.
			break;
		}
	}
	console.log(ledger.summary());
}

async function main() {
	const cfg = loadConfig();
	const once = process.argv.includes("--once");
	console.log(
		`polymarket btc arb | mode=${cfg.live ? "LIVE" : "dry-run"} minEdge=${cfg.minEdge} ` +
			`maxPerTrade=$${cfg.maxUsdPerTrade} maxDaily=$${cfg.maxDailyUsd}`,
	);

	const { client, executor } = await buildClients(cfg);
	const ctx: ScanContext = {
		cfg,
		books: new BookFetcher(client),
		risk: new RiskManager(cfg.maxDailyUsd, cfg.minProfitUsd),
		executor,
		cooldown: new Cooldown(cfg.cooldownMs),
		ledger: new PaperLedger(cfg.paperLedgerPath),
	};

	let markets: BtcMarket[] = [];
	let marketsFetchedAt = 0;

	do {
		try {
			if (Date.now() - marketsFetchedAt > MARKET_REFRESH_MS) {
				markets = await discoverBtcMarkets(cfg);
				marketsFetchedAt = Date.now();
				console.log(`tracking ${markets.length} bitcoin markets`);
			}
			await scanOnce(ctx, markets);
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
