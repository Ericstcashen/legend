import { type ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import type { ArbOpportunity, ArbPlanLeg } from "./types.js";

export interface ExecutionResult {
	executed: boolean;
	filledLegs: number;
	spentUsd: number;
	error?: string;
}

function describe(opp: ArbOpportunity): string {
	const legs = opp.legs
		.map((l) => `  ${l.leg.outcome} ${l.shares.toFixed(2)} sh @ cap ${l.capPrice.toFixed(3)} (~$${l.cost.toFixed(2)}) | ${l.leg.marketQuestion}`)
		.join("\n");
	return (
		`[${opp.kind}] ${opp.description}\n${legs}\n` +
		`  cost $${opp.totalCost.toFixed(2)} -> guaranteed $${opp.guaranteedValue.toFixed(2)} ` +
		`(profit $${opp.profit.toFixed(2)}, edge ${(opp.edge * 100).toFixed(2)}%)`
	);
}

export class DryRunExecutor {
	async execute(opp: ArbOpportunity): Promise<ExecutionResult> {
		console.log(`DRY RUN — would buy:\n${describe(opp)}`);
		return { executed: false, filledLegs: 0, spentUsd: 0 };
	}
}

/**
 * Fires one FOK buy per leg, sequentially. FOK either fills the full dollar
 * amount at or under the cap price or does nothing, so a mid-flight book move
 * leaves at most the already-filled legs as exposure — that exposure is
 * reported loudly and the remaining legs are abandoned.
 */
export class LiveExecutor {
	constructor(private client: ClobClient) {}

	private async buyLeg(leg: ArbPlanLeg): Promise<void> {
		const resp = await this.client.createAndPostMarketOrder(
			{
				tokenID: leg.leg.tokenId,
				amount: Number(leg.cost.toFixed(2)),
				price: leg.capPrice,
				side: Side.BUY,
				orderType: OrderType.FOK,
			},
			{ tickSize: leg.leg.tickSize as never, negRisk: leg.leg.negRisk },
			OrderType.FOK,
		);
		if (resp?.success === false || resp?.errorMsg) {
			throw new Error(resp.errorMsg ?? "order rejected");
		}
	}

	async execute(opp: ArbOpportunity): Promise<ExecutionResult> {
		console.log(`LIVE — buying:\n${describe(opp)}`);
		let filledLegs = 0;
		let spentUsd = 0;
		for (const leg of opp.legs) {
			try {
				await this.buyLeg(leg);
				filledLegs++;
				spentUsd += leg.cost;
			} catch (err) {
				const msg = (err as Error).message;
				if (filledLegs > 0) {
					console.error(
						`UNHEDGED: leg ${filledLegs + 1}/${opp.legs.length} failed (${msg}); ` +
							`${filledLegs} leg(s) already filled for $${spentUsd.toFixed(2)}. ` +
							`Manual action needed: complete the basket or exit the position.`,
					);
				} else {
					console.warn(`first leg failed, nothing filled: ${msg}`);
				}
				return { executed: filledLegs > 0, filledLegs, spentUsd, error: msg };
			}
		}
		console.log(`filled ${filledLegs}/${opp.legs.length} legs for $${spentUsd.toFixed(2)}`);
		return { executed: true, filledLegs, spentUsd };
	}
}

export type Executor = DryRunExecutor | LiveExecutor;
