import { existsSync } from "node:fs";
import { type ApiKeyCreds, Chain, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { allocate, Bankroll } from "./allocator.js";
import { BookFetcher } from "./books.js";
import { type Config, loadConfig } from "./config.js";
import { DryRunExecutor, type Executor, LiveExecutor } from "./executor.js";
import { discoverBtcMarkets } from "./gamma.js";
import { MintSellExecutor } from "./mintSell.js";
import { PaperLedger } from "./paper.js";
import { RecordingLegSource } from "./record.js";
import { Cooldown, RiskManager } from "./risk.js";
import { findAllArbs } from "./strategies.js";
import type { ArbLeg, BtcMarket } from "./types.js";
import { WsBookEngine } from "./wsBook.js";

/**
 * Supplies fee-adjusted legs for a set of markets. The REST source fetches on
 * demand each scan; the websocket source reads from a continuously-updated
 * in-memory book, so it sees an arb the instant the book moves.
 */
interface LegSource {
	/** Called when the tracked market set changes. */
	setMarkets(markets: BtcMarket[]): Promise<void>;
	legs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>>;
}

class RestLegSource implements LegSource {
	constructor(private books: BookFetcher) {}
	async setMarkets(): Promise<void> {}
	legs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>> {
		return this.books.fetchLegs(markets);
	}
}

class WsLegSource implements LegSource {
	constructor(private engine: WsBookEngine) {}
	setMarkets(markets: BtcMarket[]): Promise<void> {
		return this.engine.setMarkets(markets);
	}
	async legs(): Promise<Map<string, ArbLeg>> {
		return this.engine.snapshotLegs();
	}
}

const MARKET_REFRESH_MS = 10 * 60 * 1000;

async function buildClients(
	cfg: Config,
): Promise<{ client: ClobClient; executor: Executor; mintSell: MintSellExecutor | null }> {
	const chainId = cfg.chainId as Chain;

	if (!cfg.live) {
		const client = new ClobClient({ host: cfg.clobApiUrl, chain: chainId });
		return { client, executor: new DryRunExecutor(), mintSell: null };
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
	const mintSell = cfg.mintSellLive
		? new MintSellExecutor(client, signer, killSwitch)
		: null;
	if (mintSell) console.log("MINT_SELL_LIVE enabled — on-chain CTF mint-and-sell is armed");
	return { client, executor: new LiveExecutor(client, killSwitch), mintSell };
}

interface ScanContext {
	cfg: Config;
	source: LegSource;
	risk: RiskManager;
	executor: Executor;
	cooldown: Cooldown;
	ledger: PaperLedger;
	bankroll: Bankroll;
	mintSell: MintSellExecutor | null;
}

async function scanOnce(ctx: ScanContext, markets: BtcMarket[]): Promise<void> {
	const { cfg, source, risk, executor, cooldown, ledger, bankroll, mintSell } = ctx;
	if (cfg.live && bankroll.halted) {
		console.warn(`bankroll circuit breaker tripped — ${bankroll.summary()}; pausing trading`);
		return;
	}
	const legs = await source.legs(markets);
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

	// Fund the standard FOK baskets by ROI within budget. Mint-sell baskets need
	// the on-chain CTF split: run them through MintSellExecutor when armed,
	// otherwise surface them as manual opportunities.
	const fresh = opportunities.filter((o) => !cooldown.active(o) && !risk.check(o));
	for (const opp of fresh.filter((o) => !o.executable)) {
		if (mintSell && opp.kind === "mint-sell" && opp.conditionId) {
			const result = await mintSell.execute(opp);
			if (result.spentUsd > 0) risk.recordSpend(result.spentUsd);
			if (result.executed) ledger.record(opp);
			cooldown.mark(opp);
		} else {
			console.log(
				`MANUAL [${opp.kind}] ${opp.description}: $${opp.profit.toFixed(2)} available ` +
					`but needs an on-chain CTF split before selling (set MINT_SELL_LIVE=1 to automate)`,
			);
			cooldown.mark(opp);
		}
	}

	const executable = fresh.filter((o) => o.executable);
	const { chosen } = allocate(executable, risk.remainingBudget());

	for (const opp of chosen) {
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
			continue; // chosen baskets share no legs, so remaining books stay valid
		}
		if (result.filledLegs > 0) {
			// Partial (unhedged) fill: book the at-risk spend as a realized loss to
			// the bankroll breaker, then stop the scan for the operator to react.
			bankroll.update(-result.spentUsd);
			console.warn(`unhedged exposure $${result.spentUsd.toFixed(2)} — ${bankroll.summary()}`);
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

	const { client, executor, mintSell } = await buildClients(cfg);
	const wsEngine = cfg.useWebsocket
		? new WsBookEngine({ wsUrl: cfg.websocketUrl, stalenessMs: cfg.bookStalenessMs })
		: null;
	let source: LegSource = wsEngine
		? new WsLegSource(wsEngine)
		: new RestLegSource(new BookFetcher(client));
	if (cfg.recordPath) {
		source = new RecordingLegSource(source, cfg.recordPath);
		console.log(`recording books to ${cfg.recordPath}`);
	}
	console.log(`book feed: ${wsEngine ? "websocket (live)" : "REST polling"}`);
	const ctx: ScanContext = {
		cfg,
		source,
		risk: new RiskManager(cfg.maxDailyUsd, cfg.minProfitUsd),
		executor,
		cooldown: new Cooldown(cfg.cooldownMs),
		ledger: new PaperLedger(cfg.paperLedgerPath),
		bankroll: new Bankroll(cfg.maxDailyUsd, cfg.maxDrawdown),
		mintSell,
	};

	let markets: BtcMarket[] = [];
	let marketsFetchedAt = 0;

	do {
		try {
			if (Date.now() - marketsFetchedAt > MARKET_REFRESH_MS) {
				markets = await discoverBtcMarkets(cfg);
				marketsFetchedAt = Date.now();
				await source.setMarkets(markets);
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
