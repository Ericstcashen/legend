import { fileURLToPath } from "node:url";
import { DEFAULT_SIM, generateRound, Mulberry32 } from "./sim.js";
import { findAllArbs } from "./strategies.js";
import {
	type Check,
	atLeast,
	formatFeedback,
	must,
	type Verdict,
	verifier,
	type Worker,
	workerVerifierLoop,
} from "./loop.js";

/**
 * A concrete worker–verifier loop ({@link ./loop.ts}) for this repo: search for
 * an arb config that meets an objective profitability goal, using the
 * deterministic simulator as the verifier.
 *
 *   worker   → proposes a candidate { minEdge, maxUsdPerTrade }
 *   verifier → RUNS the seeded simulator on that candidate (a script, no model
 *              judgement) and checks objective criteria: net-of-fee profit, ROI,
 *              riskless invariant, pair-arb capture
 *   feedback → the exact criteria that failed, by name
 *   worker   → reacts to those names: profit short ⇒ deploy more per basket;
 *              ROI short ⇒ raise the edge floor; capture short ⇒ lower it
 *
 * Because the simulator is seeded and deterministic, the same start + goal
 * always converges to the same config — the loop is a reproducible optimizer,
 * not a stochastic one.
 */

export interface TuneCandidate {
	minEdge: number;
	maxUsdPerTrade: number;
}

export interface SimSettings {
	rounds: number;
	seed: number;
	feeBps: number;
}

export const DEFAULT_SIM_SETTINGS: SimSettings = { rounds: 200, seed: 7, feeBps: 60 };

/** Metrics produced by running the simulator on one candidate. */
export interface SimMetrics extends TuneCandidate {
	/** Ground-truth pair dislocations injected across the run. */
	injectedPairs: number;
	/** Pair arbs the candidate actually captured. */
	capturedPairs: number;
	executableTrades: number;
	/** Locked profit, net of fees, in USD. */
	netProfit: number;
	costBasis: number;
	roiPct: number;
	/** Every booked basket cost strictly less than its guaranteed value. */
	allRiskless: boolean;
}

/**
 * The verifier's engine: run the real scanner/strategies over the seeded
 * synthetic books and measure what the candidate captures. Deterministic — no
 * network, no model, same input ⇒ same metrics.
 */
export function runSimulation(
	candidate: TuneCandidate,
	settings: SimSettings = DEFAULT_SIM_SETTINGS,
): SimMetrics {
	const rng = new Mulberry32(settings.seed);
	let injectedPairs = 0;
	let capturedPairs = 0;
	let executableTrades = 0;
	let netProfit = 0;
	let costBasis = 0;
	let allRiskless = true;

	for (let r = 0; r < settings.rounds; r++) {
		const round = generateRound({ ...DEFAULT_SIM, seed: settings.seed, feeRateBps: settings.feeBps }, rng, r);
		injectedPairs += round.injected.pair;
		const opportunities = findAllArbs({
			markets: round.markets,
			legs: round.legs,
			minEdge: candidate.minEdge,
			maxUsdPerTrade: candidate.maxUsdPerTrade,
		});
		for (const opp of opportunities) {
			if (opp.kind === "pair") capturedPairs++;
			if (!opp.executable) continue;
			executableTrades++;
			netProfit += opp.profit;
			costBasis += opp.totalCost;
			if (opp.totalCost >= opp.guaranteedValue) allRiskless = false;
		}
	}

	const roiPct = costBasis > 0 ? (netProfit / costBasis) * 100 : 0;
	return {
		minEdge: candidate.minEdge,
		maxUsdPerTrade: candidate.maxUsdPerTrade,
		injectedPairs,
		capturedPairs,
		executableTrades,
		netProfit,
		costBasis,
		roiPct,
		allRiskless,
	};
}

/** The objective criteria — the "goal" the loop must satisfy. */
export interface TuneGoal {
	minProfit: number;
	minRoiPct: number;
	minCapturedPairs: number;
}

export const DEFAULT_GOAL: TuneGoal = { minProfit: 3300, minRoiPct: 17, minCapturedPairs: 60 };

/** Named, objective checks over the simulated metrics — pure, no model. */
export function makeVerifier(goal: TuneGoal): (m: SimMetrics) => Verdict {
	return verifier<SimMetrics>([
		atLeast("net profit", (m) => m.netProfit, goal.minProfit, " USD"),
		atLeast("ROI", (m) => m.roiPct, goal.minRoiPct, "%"),
		atLeast("pair capture", (m) => m.capturedPairs, goal.minCapturedPairs, " arbs"),
		must(
			"riskless baskets",
			(m) => m.allRiskless,
			"a booked basket cost >= its guaranteed redemption value",
		),
	]);
}

const CHECK_NAMES = {
	profit: "net profit",
	roi: "ROI",
	capture: "pair capture",
} as const;

function failed(feedback: Check[], name: string): boolean {
	return feedback.some((c) => c.name === name);
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Translate the failed criteria into config moves. Each lever is chosen to push
 * the metric that failed with minimal collateral damage to the others:
 *   - profit short  ⇒ deploy more per basket (scales profit, ~ROI-neutral)
 *   - ROI short     ⇒ raise the edge floor (drops thin, low-margin trades)
 *   - capture short ⇒ lower the edge floor (admits more qualifying arbs)
 */
export function adjust(candidate: TuneCandidate, feedback: Check[]): TuneCandidate {
	let { minEdge, maxUsdPerTrade } = candidate;
	if (failed(feedback, CHECK_NAMES.profit)) {
		maxUsdPerTrade = Math.min(maxUsdPerTrade * 2, 500);
	}
	if (failed(feedback, CHECK_NAMES.roi)) {
		minEdge = round3(minEdge + 0.01);
	}
	if (failed(feedback, CHECK_NAMES.capture)) {
		minEdge = Math.max(0.005, round3(minEdge - 0.01));
	}
	return { minEdge, maxUsdPerTrade };
}

/** A worker that proposes a candidate, adjusting from the prior feedback. */
export function makeWorker(
	start: TuneCandidate,
	settings: SimSettings = DEFAULT_SIM_SETTINGS,
): Worker<SimMetrics> {
	let candidate = { ...start };
	return ({ n, feedback }) => {
		if (n > 1) candidate = adjust(candidate, feedback);
		return runSimulation(candidate, settings);
	};
}

export interface TuneOptions {
	start: TuneCandidate;
	goal: TuneGoal;
	settings: SimSettings;
	maxAttempts: number;
	onAttempt?: (m: SimMetrics, attemptNo: number, ok: boolean, feedback: Check[]) => void;
}

/**
 * Run the full tuning loop. The worker's output IS the measured metrics, and
 * the verifier checks them — so the loop's history carries both the config that
 * was tried (minEdge/maxUsdPerTrade live on the metrics) and how it scored.
 */
export async function tune(opts: TuneOptions) {
	const verify = makeVerifier(opts.goal);
	const worker = makeWorker(opts.start, opts.settings);
	return workerVerifierLoop<SimMetrics>({
		worker,
		verify,
		maxAttempts: opts.maxAttempts,
		onAttempt: (a) => opts.onAttempt?.(a.output, a.n, a.verdict.ok, a.feedback),
	});
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= process.argv.length) return fallback;
	const v = Number(process.argv[i + 1]);
	return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
	const settings: SimSettings = {
		rounds: arg("rounds", DEFAULT_SIM_SETTINGS.rounds),
		seed: arg("seed", DEFAULT_SIM_SETTINGS.seed),
		feeBps: arg("fee", DEFAULT_SIM_SETTINGS.feeBps),
	};
	const goal: TuneGoal = {
		minProfit: arg("min-profit", DEFAULT_GOAL.minProfit),
		minRoiPct: arg("min-roi", DEFAULT_GOAL.minRoiPct),
		minCapturedPairs: arg("min-capture", DEFAULT_GOAL.minCapturedPairs),
	};
	const start: TuneCandidate = {
		minEdge: arg("start-edge", 0.12),
		maxUsdPerTrade: arg("start-usd", 20),
	};
	const maxAttempts = arg("max-attempts", 15);

	console.log(
		`tune | ${settings.rounds} rounds seed=${settings.seed} fee=${settings.feeBps}bps | ` +
			`goal: profit>=$${goal.minProfit} roi>=${goal.minRoiPct}% capture>=${goal.minCapturedPairs} | ` +
			`start: minEdge=${start.minEdge} maxUsd=$${start.maxUsdPerTrade} | cap=${maxAttempts} attempts`,
	);

	const outcome = await tune({
		start,
		goal,
		settings,
		maxAttempts,
		onAttempt: (m, n, ok, feedback) => {
			console.log(
				`\nattempt ${n}: minEdge=${m.minEdge} maxUsd=$${m.maxUsdPerTrade} ` +
					`→ profit=$${m.netProfit.toFixed(2)} roi=${m.roiPct.toFixed(2)}% ` +
					`captured=${m.capturedPairs}/${m.injectedPairs} riskless=${m.allRiskless} ` +
					`${ok ? "✓ PASS" : "✗ fail"}`,
			);
		},
	});

	console.log("\n" + "=".repeat(60));
	if (outcome.ok) {
		const m = outcome.output as SimMetrics;
		console.log(
			`CONVERGED in ${outcome.attempts} attempt(s): ` +
				`minEdge=${m.minEdge} maxUsdPerTrade=$${m.maxUsdPerTrade}`,
		);
		console.log(
			`  profit=$${m.netProfit.toFixed(2)} roi=${m.roiPct.toFixed(2)}% ` +
				`captured=${m.capturedPairs}/${m.injectedPairs} trades=${m.executableTrades}`,
		);
	} else {
		console.log(`NO CONFIG MET THE GOAL within ${outcome.attempts} attempts. Last failures:`);
		console.log(formatFeedback(outcome.verdict ? outcome.verdict.checks.filter((c) => !c.pass) : []));
		process.exitCode = 1;
	}
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
	void main();
}
