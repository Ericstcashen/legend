import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ArbLeg, BtcMarket } from "./types.js";

/**
 * One timestamped capture of the markets and their fee-adjusted books, as the
 * scanner saw them. Recording these while connected to live endpoints builds a
 * dataset of *real* market conditions that the backtester can later replay
 * through the exact strategy pipeline — the bridge from synthetic simulation
 * to measured performance on real books.
 */
export interface Snapshot {
	ts: string;
	markets: BtcMarket[];
	legs: ArbLeg[];
}

export interface LegSource {
	setMarkets(markets: BtcMarket[]): Promise<void>;
	legs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>>;
}

/**
 * Decorates any LegSource, teeing each scan's snapshot to a JSONL file while
 * passing the legs through unchanged. Recording adds one append per scan and
 * never blocks trading.
 */
export class RecordingLegSource implements LegSource {
	constructor(
		private inner: LegSource,
		private path: string,
	) {
		mkdirSync(dirname(path), { recursive: true });
	}

	setMarkets(markets: BtcMarket[]): Promise<void> {
		return this.inner.setMarkets(markets);
	}

	async legs(markets: BtcMarket[]): Promise<Map<string, ArbLeg>> {
		const legs = await this.inner.legs(markets);
		const snapshot: Snapshot = { ts: new Date().toISOString(), markets, legs: [...legs.values()] };
		try {
			appendFileSync(this.path, `${JSON.stringify(snapshot)}\n`);
		} catch {
			// Recording is best-effort; never let it interrupt a scan.
		}
		return legs;
	}
}

/** Parse a JSONL recording into snapshots, skipping malformed lines. */
export function parseRecording(contents: string): Snapshot[] {
	const out: Snapshot[] = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Snapshot);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}
