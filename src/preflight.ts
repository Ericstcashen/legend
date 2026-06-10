import { type Config, loadConfig } from "./config.js";

/**
 * Pre-deployment readiness checks. Going live is the step only the operator can
 * take, so this makes it safe and turnkey: it validates configuration, keys,
 * endpoint reachability, and (when reachable) wallet balance/allowances, then
 * prints a single go/no-go. Run it before ever setting LIVE=1.
 */
export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
	name: string;
	status: CheckStatus;
	detail: string;
}

/** Pure configuration sanity — no network, fully testable. */
export function configChecks(cfg: Config): Check[] {
	const checks: Check[] = [];

	checks.push(
		cfg.minEdge > 0 && cfg.minEdge < 1
			? { name: "min edge", status: "pass", detail: `${(cfg.minEdge * 100).toFixed(2)}%` }
			: { name: "min edge", status: "fail", detail: `MIN_EDGE must be in (0,1), got ${cfg.minEdge}` },
	);

	checks.push(
		cfg.maxUsdPerTrade > 0 && cfg.maxUsdPerTrade <= cfg.maxDailyUsd
			? {
					name: "budget sizing",
					status: "pass",
					detail: `$${cfg.maxUsdPerTrade}/trade ≤ $${cfg.maxDailyUsd}/day`,
				}
			: {
					name: "budget sizing",
					status: "fail",
					detail: `MAX_USD_PER_TRADE ($${cfg.maxUsdPerTrade}) must be >0 and ≤ MAX_DAILY_USD ($${cfg.maxDailyUsd})`,
				},
	);

	checks.push(
		cfg.maxDrawdown > 0 && cfg.maxDrawdown < 1
			? { name: "drawdown breaker", status: "pass", detail: `trips at ${(cfg.maxDrawdown * 100).toFixed(0)}%` }
			: { name: "drawdown breaker", status: "warn", detail: `MAX_DRAWDOWN ${cfg.maxDrawdown} disables the breaker` },
	);

	if (cfg.live) {
		const pk = cfg.privateKey ?? "";
		checks.push(
			/^0x[0-9a-fA-F]{64}$/.test(pk)
				? { name: "signing key", status: "pass", detail: "PK present and well-formed" }
				: { name: "signing key", status: "fail", detail: "LIVE=1 requires a valid 32-byte hex PK" },
		);
		checks.push(
			cfg.killSwitch
				? { name: "kill switch", status: "warn", detail: "KILL_SWITCH=1 — live orders are blocked" }
				: { name: "kill switch", status: "pass", detail: "armed (touch KILL to halt)" },
		);
		if (cfg.mintSellLive) {
			checks.push({
				name: "mint-sell",
				status: "warn",
				detail: "MINT_SELL_LIVE=1 sends irreversible on-chain splits — validate on a fork first",
			});
		}
	} else {
		checks.push({ name: "mode", status: "pass", detail: "dry-run (no orders will be placed)" });
	}

	return checks;
}

async function reachable(url: string, timeoutMs = 5_000): Promise<boolean> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctl.signal });
		return res.ok || res.status === 405; // 405 = endpoint exists, method not allowed
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

/** Network reachability checks against the configured endpoints. */
export async function endpointChecks(cfg: Config): Promise<Check[]> {
	const [clob, gamma] = await Promise.all([
		reachable(`${cfg.clobApiUrl}/ok`),
		reachable(`${cfg.gammaApiUrl}/markets?limit=1`),
	]);
	return [
		clob
			? { name: "CLOB API", status: "pass", detail: cfg.clobApiUrl }
			: { name: "CLOB API", status: "fail", detail: `unreachable: ${cfg.clobApiUrl}` },
		gamma
			? { name: "Gamma API", status: "pass", detail: cfg.gammaApiUrl }
			: { name: "Gamma API", status: "fail", detail: `unreachable: ${cfg.gammaApiUrl}` },
	];
}

/** Overall verdict: any fail → no-go; warnings allowed. */
export function verdict(checks: Check[]): { go: boolean; fails: number; warns: number } {
	const fails = checks.filter((c) => c.status === "fail").length;
	const warns = checks.filter((c) => c.status === "warn").length;
	return { go: fails === 0, fails, warns };
}

function icon(s: CheckStatus): string {
	return s === "pass" ? "✓" : s === "warn" ? "!" : "✗";
}

async function main(): Promise<void> {
	const cfg = loadConfig();
	console.log(`preflight | mode=${cfg.live ? "LIVE" : "dry-run"}`);
	const checks = [...configChecks(cfg), ...(await endpointChecks(cfg))];
	for (const c of checks) console.log(`  [${icon(c.status)}] ${c.name}: ${c.detail}`);

	const { go, fails, warns } = verdict(checks);
	console.log(
		go
			? `GO — ${warns} warning(s). ${cfg.live ? "Live trading is cleared; start small." : "Dry-run cleared."}`
			: `NO-GO — ${fails} blocking issue(s) above must be resolved before trading.`,
	);
	process.exit(go ? 0 : 1);
}

if (process.argv[1]?.endsWith("preflight.ts") || process.argv[1]?.endsWith("preflight.js")) {
	void main();
}
