import { feeAdjustAsks, feeAdjustBids } from "./arbMath.js";
import type { ArbLeg, BookLevel, BtcMarket } from "./types.js";

/**
 * Pure, transport-free order-book state. Applies CLOB market-channel messages
 * (`book` snapshots and `price_change` deltas) to per-asset bid/ask maps and
 * yields sorted top-of-book on demand. Kept separate from the socket so the
 * delta-application logic — the part most likely to have bugs — is unit
 * testable without a network.
 */
export class BookState {
	// asset_id -> price -> size, for each side.
	private bids = new Map<string, Map<number, number>>();
	private asks = new Map<string, Map<number, number>>();
	private updatedAt = new Map<string, number>();

	private sideMap(side: "bid" | "ask", asset: string): Map<number, number> {
		const root = side === "bid" ? this.bids : this.asks;
		let m = root.get(asset);
		if (!m) {
			m = new Map();
			root.set(asset, m);
		}
		return m;
	}

	/** Replace both sides of one asset's book from a full snapshot. */
	applySnapshot(
		asset: string,
		bids: { price: string; size: string }[],
		asks: { price: string; size: string }[],
		now = Date.now(),
	): void {
		const toMap = (levels: { price: string; size: string }[]) => {
			const m = new Map<number, number>();
			for (const l of levels) {
				const price = Number(l.price);
				const size = Number(l.size);
				if (price > 0.001 && price < 0.999 && size > 0) m.set(price, size);
			}
			return m;
		};
		this.bids.set(asset, toMap(bids));
		this.asks.set(asset, toMap(asks));
		this.updatedAt.set(asset, now);
	}

	/**
	 * Apply incremental level changes. Each change is [side, price, size] where
	 * side is "BUY" (bid) or "SELL" (ask); size 0 removes the level.
	 */
	applyChanges(
		asset: string,
		changes: [string, string, string][],
		now = Date.now(),
	): void {
		for (const [rawSide, priceStr, sizeStr] of changes) {
			const price = Number(priceStr);
			const size = Number(sizeStr);
			if (!(price > 0.001 && price < 0.999)) continue;
			const m = this.sideMap(rawSide === "BUY" ? "bid" : "ask", asset);
			if (size > 0) m.set(price, size);
			else m.delete(price);
		}
		this.updatedAt.set(asset, now);
	}

	private levels(side: "bid" | "ask", asset: string): BookLevel[] {
		const m = (side === "bid" ? this.bids : this.asks).get(asset);
		if (!m) return [];
		const arr = [...m.entries()].map(([price, size]) => ({ price, size }));
		arr.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
		return arr;
	}

	asksFor(asset: string): BookLevel[] {
		return this.levels("ask", asset);
	}
	bidsFor(asset: string): BookLevel[] {
		return this.levels("bid", asset);
	}

	/** Milliseconds since this asset last received an update, or Infinity. */
	ageMs(asset: string, now = Date.now()): number {
		const at = this.updatedAt.get(asset);
		return at === undefined ? Number.POSITIVE_INFINITY : now - at;
	}

	hasBook(asset: string): boolean {
		return this.updatedAt.has(asset);
	}
}

/** Normalize one CLOB market-channel message into BookState (handles batches upstream). */
export function applyMarketMessage(state: BookState, msg: unknown, now = Date.now()): void {
	if (!msg || typeof msg !== "object") return;
	const m = msg as Record<string, unknown>;
	const asset = typeof m.asset_id === "string" ? m.asset_id : "";
	if (!asset) return;
	if (m.event_type === "book") {
		state.applySnapshot(
			asset,
			(m.bids as { price: string; size: string }[]) ?? [],
			(m.asks as { price: string; size: string }[]) ?? [],
			now,
		);
	} else if (m.event_type === "price_change") {
		state.applyChanges(asset, (m.changes as [string, string, string][]) ?? [], now);
	}
}

export interface WsBookEngineOptions {
	wsUrl?: string;
	feeRateBps?: number;
	/** Books older than this are considered stale and excluded from snapshots. */
	stalenessMs?: number;
}

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/**
 * Maintains live book state over the CLOB market websocket and produces
 * fee-adjusted ArbLeg snapshots with zero per-scan network latency. The
 * scanner reads the in-memory state instead of issuing REST batches, so an
 * arb is seen the instant the book moves rather than up to a poll interval
 * later — the latency that decides who captures a fleeting edge.
 *
 * The `ws` dependency is imported lazily so the rest of the toolkit (and the
 * offline simulator) runs without it installed.
 */
export class WsBookEngine {
	private state = new BookState();
	private ws: import("ws").WebSocket | null = null;
	private assets = new Set<string>();
	private meta = new Map<string, { question: string; outcome: string; negRisk: boolean }>();
	private url: string;
	private feeRateBps: number;
	private stalenessMs: number;
	private running = false;

	constructor(opts: WsBookEngineOptions = {}) {
		this.url = opts.wsUrl ?? DEFAULT_WS_URL;
		this.feeRateBps = opts.feeRateBps ?? 0;
		this.stalenessMs = opts.stalenessMs ?? 5_000;
	}

	/** Track these markets' tokens and (re)subscribe. */
	async setMarkets(markets: BtcMarket[]): Promise<void> {
		this.assets.clear();
		this.meta.clear();
		for (const m of markets) {
			this.assets.add(m.yesTokenId);
			this.assets.add(m.noTokenId);
			this.meta.set(m.yesTokenId, { question: m.question, outcome: "Yes", negRisk: m.negRisk });
			this.meta.set(m.noTokenId, { question: m.question, outcome: "No", negRisk: m.negRisk });
		}
		await this.connect();
	}

	private async connect(): Promise<void> {
		const { WebSocket } = await import("ws");
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// already closing
			}
		}
		this.running = true;
		const ws = new WebSocket(this.url);
		this.ws = ws;
		ws.on("open", () => {
			ws.send(JSON.stringify({ assets_ids: [...this.assets], type: "market" }));
		});
		ws.on("message", (raw: Buffer) => {
			try {
				const parsed = JSON.parse(raw.toString());
				const arr = Array.isArray(parsed) ? parsed : [parsed];
				for (const msg of arr) applyMarketMessage(this.state, msg);
			} catch {
				// ignore malformed frames
			}
		});
		ws.on("close", () => {
			if (this.running) setTimeout(() => void this.connect(), 500);
		});
		ws.on("error", () => {
			// 'close' will follow and trigger reconnect
		});
	}

	stop(): void {
		this.running = false;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// already closed
			}
		}
	}

	/** Are at least half the tracked assets carrying a fresh book? */
	get ready(): boolean {
		if (this.assets.size === 0) return false;
		let fresh = 0;
		for (const a of this.assets) {
			if (this.state.hasBook(a) && this.state.ageMs(a) < this.stalenessMs) fresh++;
		}
		return fresh >= this.assets.size / 2;
	}

	/** Fee-adjusted legs from current in-memory state; skips stale/empty books. */
	snapshotLegs(now = Date.now()): Map<string, ArbLeg> {
		const legs = new Map<string, ArbLeg>();
		for (const asset of this.assets) {
			if (!this.state.hasBook(asset) || this.state.ageMs(asset, now) >= this.stalenessMs) continue;
			const meta = this.meta.get(asset);
			if (!meta) continue;
			const asks = feeAdjustAsks(this.state.asksFor(asset), this.feeRateBps);
			const bids = feeAdjustBids(this.state.bidsFor(asset), this.feeRateBps);
			if (asks.length === 0 && bids.length === 0) continue;
			legs.set(asset, {
				tokenId: asset,
				marketQuestion: meta.question,
				outcome: meta.outcome,
				asks,
				bids,
				tickSize: "0.01",
				negRisk: meta.negRisk,
			});
		}
		return legs;
	}
}
