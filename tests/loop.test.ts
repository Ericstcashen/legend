import { describe, expect, it } from "vitest";
import {
	type Attempt,
	type Check,
	atLeast,
	atMost,
	failures,
	formatFeedback,
	must,
	verifier,
	workerVerifierLoop,
} from "../src/loop.js";

describe("criterion builders", () => {
	it("atLeast passes at/above the threshold and reports the gap", () => {
		const c = atLeast<{ v: number }>("score", (o) => o.v, 10, "pts");
		expect(c({ v: 10 }).pass).toBe(true);
		expect(c({ v: 11 }).pass).toBe(true);
		const fail = c({ v: 4 });
		expect(fail.pass).toBe(false);
		expect(fail.detail).toContain("4pts");
		expect(fail.detail).toContain(">= 10pts");
	});

	it("atMost passes at/below the threshold", () => {
		const c = atMost<{ v: number }>("cost", (o) => o.v, 5);
		expect(c({ v: 5 }).pass).toBe(true);
		expect(c({ v: 6 }).pass).toBe(false);
	});

	it("must reports whyFail only on failure", () => {
		const c = must<{ ok: boolean }>("invariant", (o) => o.ok, "broke the invariant");
		expect(c({ ok: true })).toEqual({ name: "invariant", pass: true, detail: "ok" });
		expect(c({ ok: false }).detail).toBe("broke the invariant");
	});
});

describe("verifier", () => {
	it("ok only when every criterion passes", () => {
		const verify = verifier<{ a: number; b: number }>([
			atLeast("a", (o) => o.a, 1),
			atMost("b", (o) => o.b, 1),
		]);
		expect(verify({ a: 2, b: 0 }).ok).toBe(true);
		expect(verify({ a: 0, b: 0 }).ok).toBe(false);
		expect(verify({ a: 2, b: 2 }).ok).toBe(false);
	});

	it("failures() returns only the failed checks", () => {
		const verify = verifier<number>([
			atLeast("hi", (n) => n, 10),
			atMost("lo", (n) => n, 100),
		]);
		const v = verify(5);
		expect(v.ok).toBe(false);
		const f = failures(v);
		expect(f.map((c) => c.name)).toEqual(["hi"]);
	});
});

describe("formatFeedback", () => {
	it("summarizes passing and failing states", () => {
		expect(formatFeedback([])).toBe("all checks passed");
		const checks: Check[] = [
			{ name: "x", pass: false, detail: "too low" },
			{ name: "y", pass: false, detail: "too high" },
		];
		expect(formatFeedback(checks)).toBe("- x: too low\n- y: too high");
	});
});

describe("workerVerifierLoop", () => {
	it("stops on the first pass without further attempts", async () => {
		let calls = 0;
		const outcome = await workerVerifierLoop<number>({
			worker: () => {
				calls++;
				return 42;
			},
			verify: verifier<number>([atLeast("v", (n) => n, 1)]),
			maxAttempts: 5,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.attempts).toBe(1);
		expect(calls).toBe(1);
		expect(outcome.output).toBe(42);
	});

	it("feeds the previous attempt's failed checks (not 'try again') into the next worker call", async () => {
		const seen: Check[][] = [];
		const outcome = await workerVerifierLoop<number>({
			worker: ({ n, feedback }) => {
				seen.push(feedback);
				return n; // 1, 2, 3, ... until it clears the bar
			},
			verify: verifier<number>([atLeast("reach-3", (n) => n, 3)]),
			maxAttempts: 5,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.attempts).toBe(3);
		// First attempt gets no feedback; later attempts get the specific failure.
		expect(seen[0]).toEqual([]);
		expect(seen[1]?.map((c) => c.name)).toEqual(["reach-3"]);
		expect(seen[1]?.[0]?.detail).toContain(">= 3");
	});

	it("stops at the attempt cap when the goal is never met", async () => {
		const outcome = await workerVerifierLoop<number>({
			worker: () => 0,
			verify: verifier<number>([atLeast("impossible", (n) => n, 1)]),
			maxAttempts: 3,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(3);
		expect(outcome.history).toHaveLength(3);
		expect(outcome.verdict?.ok).toBe(false);
	});

	it("records full history and reports each attempt via onAttempt", async () => {
		const log: Attempt<number>[] = [];
		const outcome = await workerVerifierLoop<number>({
			worker: ({ n }) => n,
			verify: verifier<number>([atLeast("reach-2", (n) => n, 2)]),
			maxAttempts: 5,
			onAttempt: (a) => log.push(a),
		});
		expect(log.map((a) => a.n)).toEqual([1, 2]);
		expect(outcome.history.map((a) => a.output)).toEqual([1, 2]);
	});

	it("rejects a non-positive attempt cap", async () => {
		await expect(
			workerVerifierLoop<number>({ worker: () => 1, verify: () => ({ ok: true, checks: [] }), maxAttempts: 0 }),
		).rejects.toThrow(/maxAttempts/);
	});

	it("awaits async workers and verifiers", async () => {
		const outcome = await workerVerifierLoop<number>({
			worker: async ({ n }) => n,
			verify: async (n) => ({ ok: n >= 2, checks: [{ name: "v", pass: n >= 2, detail: "" }] }),
			maxAttempts: 4,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.attempts).toBe(2);
	});
});
