import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { configChecks, verdict } from "../src/preflight.js";

function cfg(overrides: Partial<Config> = {}): Config {
	return {
		gammaApiUrl: "https://gamma",
		clobApiUrl: "https://clob",
		chainId: 137,
		tagSlugs: ["bitcoin"],
		keywords: ["bitcoin"],
		maxGammaPages: 4,
		scanIntervalMs: 15000,
		minEdge: 0.01,
		minProfitUsd: 0.25,
		maxUsdPerTrade: 100,
		maxDailyUsd: 500,
		maxDrawdown: 0.1,
		useWebsocket: false,
		websocketUrl: "wss://ws",
		bookStalenessMs: 5000,
		cooldownMs: 1000,
		paperLedgerPath: "x.jsonl",
		live: false,
		killSwitch: false,
		mintSellLive: false,
		...overrides,
	};
}

describe("configChecks", () => {
	it("passes a sane dry-run config", () => {
		expect(verdict(configChecks(cfg())).go).toBe(true);
	});

	it("fails when min edge is out of range", () => {
		const checks = configChecks(cfg({ minEdge: 0 }));
		expect(verdict(checks).go).toBe(false);
	});

	it("fails when per-trade budget exceeds daily budget", () => {
		const checks = configChecks(cfg({ maxUsdPerTrade: 600, maxDailyUsd: 500 }));
		expect(verdict(checks).go).toBe(false);
	});

	it("fails live mode without a valid key", () => {
		const checks = configChecks(cfg({ live: true, privateKey: undefined }));
		expect(verdict(checks).go).toBe(false);
		const checks2 = configChecks(cfg({ live: true, privateKey: "0xnothex" }));
		expect(verdict(checks2).go).toBe(false);
	});

	it("clears live mode with a well-formed key, warning on risky flags", () => {
		const pk = `0x${"a".repeat(64)}`;
		const checks = configChecks(cfg({ live: true, privateKey: pk, mintSellLive: true }));
		const v = verdict(checks);
		expect(v.go).toBe(true); // valid config — go despite warnings
		expect(v.warns).toBeGreaterThan(0); // mint-sell warning present
	});

	it("warns when the drawdown breaker is disabled", () => {
		const checks = configChecks(cfg({ maxDrawdown: 0 }));
		expect(checks.find((c) => c.name === "drawdown breaker")?.status).toBe("warn");
		expect(verdict(checks).go).toBe(true); // warning, not blocking
	});
});

describe("verdict", () => {
	it("blocks on any fail, allows warnings", () => {
		expect(verdict([{ name: "a", status: "pass", detail: "" }]).go).toBe(true);
		expect(verdict([{ name: "a", status: "warn", detail: "" }]).go).toBe(true);
		expect(verdict([{ name: "a", status: "fail", detail: "" }]).go).toBe(false);
	});
});
