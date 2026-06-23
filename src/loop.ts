/**
 * Worker–verifier loop — a generic harness for "generate, then objectively
 * check, then retry against the specific failures".
 *
 *   goal + objective criteria
 *     → worker produces an output
 *     → a *script* verifier runs (deterministic, no model judgement)
 *     → on fail, the worker is handed WHAT failed (not "try again") and retries
 *     → capped at N attempts; stops the instant a verdict passes
 *
 * The contract that makes this useful: verification is a list of named,
 * objective {@link Criterion}s that each say what was measured versus what was
 * required. Their failures ARE the feedback — the next worker attempt receives
 * the exact checks that did not pass, so it can react to specifics instead of
 * blindly regenerating.
 *
 * Nothing here is domain-specific. See {@link ./tune.ts} for a concrete use:
 * tuning the arb config against the deterministic simulator as the verifier.
 */

/** One objective check's outcome — the unit of "what failed" feedback. */
export interface Check {
	name: string;
	pass: boolean;
	/** What was measured versus what was required (human- and log-readable). */
	detail: string;
}

/** The verifier's full verdict for one output. */
export interface Verdict {
	ok: boolean;
	checks: Check[];
}

/** A criterion maps an output to a single named check. Must be deterministic. */
export type Criterion<O> = (output: O) => Check;

/** The failed checks only — exactly what gets fed into the next attempt. */
export function failures(verdict: Verdict): Check[] {
	return verdict.checks.filter((c) => !c.pass);
}

/** Render checks as a feedback block for logs (or a model prompt). */
export function formatFeedback(checks: Check[]): string {
	if (checks.length === 0) return "all checks passed";
	return checks.map((c) => `- ${c.name}: ${c.detail}`).join("\n");
}

function fmt(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Pass when `measure(output) >= min`. */
export function atLeast<O>(
	name: string,
	measure: (o: O) => number,
	min: number,
	unit = "",
): Criterion<O> {
	return (o) => {
		const v = measure(o);
		return { name, pass: v >= min, detail: `${fmt(v)}${unit} (need >= ${fmt(min)}${unit})` };
	};
}

/** Pass when `measure(output) <= max`. */
export function atMost<O>(
	name: string,
	measure: (o: O) => number,
	max: number,
	unit = "",
): Criterion<O> {
	return (o) => {
		const v = measure(o);
		return { name, pass: v <= max, detail: `${fmt(v)}${unit} (need <= ${fmt(max)}${unit})` };
	};
}

/** Pass when `predicate(output)` holds; on failure the check reports `whyFail`. */
export function must<O>(
	name: string,
	predicate: (o: O) => boolean,
	whyFail: string,
): Criterion<O> {
	return (o) => {
		const pass = predicate(o);
		return { name, pass, detail: pass ? "ok" : whyFail };
	};
}

/** Build a script verifier from a list of objective criteria. */
export function verifier<O>(criteria: Criterion<O>[]): (output: O) => Verdict {
	return (output) => {
		const checks = criteria.map((c) => c(output));
		return { ok: checks.every((c) => c.pass), checks };
	};
}

/** What the worker is told before producing attempt `n`. */
export interface WorkerContext<O> {
	/** 1-based attempt number. */
	n: number;
	/** Failed checks from the previous attempt; empty on the first attempt. */
	feedback: Check[];
	/** Every attempt so far, in order. */
	history: ReadonlyArray<Attempt<O>>;
}

export type Worker<O> = (ctx: WorkerContext<O>) => O | Promise<O>;
export type Verify<O> = (output: O) => Verdict | Promise<Verdict>;

/** One worker→verify round. */
export interface Attempt<O> {
	n: number;
	/** The feedback handed to the worker for this attempt (empty on n=1). */
	feedback: Check[];
	output: O;
	verdict: Verdict;
}

export interface LoopOutcome<O> {
	/** Did a verdict pass within the attempt cap? */
	ok: boolean;
	attempts: number;
	/** The last attempt's output (the passing one when `ok`). */
	output?: O;
	verdict?: Verdict;
	history: Attempt<O>[];
}

export interface LoopOptions<O> {
	worker: Worker<O>;
	verify: Verify<O>;
	/** Hard cap on attempts; the loop stops on the first pass or here. */
	maxAttempts: number;
	/** Observe each attempt as it completes (e.g. for logging). */
	onAttempt?: (attempt: Attempt<O>) => void;
}

/**
 * Drive a worker against a verifier until a verdict passes or `maxAttempts` is
 * reached. The worker receives the prior attempt's failed checks as feedback —
 * the loop never says "try again", it says exactly which criteria failed.
 */
export async function workerVerifierLoop<O>(opts: LoopOptions<O>): Promise<LoopOutcome<O>> {
	const { worker, verify, maxAttempts, onAttempt } = opts;
	if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");

	const history: Attempt<O>[] = [];
	let feedback: Check[] = [];

	for (let n = 1; n <= maxAttempts; n++) {
		const output = await worker({ n, feedback, history });
		const verdict = await verify(output);
		const attempt: Attempt<O> = { n, feedback, output, verdict };
		history.push(attempt);
		onAttempt?.(attempt);

		if (verdict.ok) {
			return { ok: true, attempts: n, output, verdict, history };
		}
		feedback = failures(verdict); // WHAT failed — handed to the next attempt
	}

	const last = history[history.length - 1];
	return {
		ok: false,
		attempts: history.length,
		output: last?.output,
		verdict: last?.verdict,
		history,
	};
}
