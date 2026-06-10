import { type ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import type { WalletClient } from "viem";
import {
	encodeSplitPosition,
	POLYGON_CTF,
	POLYGON_NEG_RISK_ADAPTER,
} from "./ctf.js";
import type { ExecutionResult } from "./executor.js";
import type { ArbOpportunity } from "./types.js";

/**
 * Executes mint-and-sell baskets: split USDC into a complete outcome set on
 * the CTF, then sell every leg into its bids with FOK orders. Both steps must
 * land for the profit to realize; this is gated behind its own opt-in flag
 * (separate from LIVE) because the split is an irreversible on-chain transfer.
 *
 * The on-chain broadcast path cannot be exercised from a sandbox without a
 * forked node, so callers must validate against a testnet/fork before enabling
 * it against mainnet funds.
 */
export class MintSellExecutor {
	constructor(
		private client: ClobClient,
		private wallet: WalletClient,
		private killSwitch: () => boolean,
	) {}

	private async splitCollateral(opp: ArbOpportunity): Promise<Hex> {
		if (!opp.conditionId) throw new Error("mint-sell opportunity missing conditionId");
		const negRisk = opp.legs.some((l) => l.leg.negRisk);
		const to = (negRisk ? POLYGON_NEG_RISK_ADAPTER : POLYGON_CTF) as Hex;
		const data = encodeSplitPosition({
			conditionId: opp.conditionId as Hex,
			amount: opp.shares,
		});
		const account = this.wallet.account;
		if (!account) throw new Error("wallet client has no account");
		// viem infers chain from the wallet client; throws on revert/timeout.
		return this.wallet.sendTransaction({ account, to, data, chain: null });
	}

	private async sellLeg(leg: ArbOpportunity["legs"][number]): Promise<void> {
		const resp = await this.client.createAndPostMarketOrder(
			{
				tokenID: leg.leg.tokenId,
				amount: Number(leg.shares.toFixed(2)),
				price: leg.capPrice,
				side: Side.SELL,
				orderType: OrderType.FOK,
			},
			{ tickSize: leg.leg.tickSize as never, negRisk: leg.leg.negRisk },
			OrderType.FOK,
		);
		if (resp?.success === false || resp?.errorMsg) {
			throw new Error(resp.errorMsg ?? "sell order rejected");
		}
	}

	async execute(opp: ArbOpportunity): Promise<ExecutionResult> {
		if (this.killSwitch()) {
			console.warn("KILL_SWITCH active — refusing mint-sell");
			return { executed: false, filledLegs: 0, spentUsd: 0, error: "kill switch" };
		}
		console.log(
			`MINT-SELL — splitting $${opp.shares.toFixed(2)} then selling ${opp.legs.length} legs | ${opp.description}`,
		);

		let txHash: string;
		try {
			txHash = await this.splitCollateral(opp);
			console.log(`  split tx ${txHash}`);
		} catch (err) {
			console.warn(`mint-sell split failed, nothing minted: ${(err as Error).message}`);
			return { executed: false, filledLegs: 0, spentUsd: 0, error: (err as Error).message };
		}

		// Collateral is now minted into outcome tokens; sell each leg. A failed
		// sell leaves redeemable inventory (worth >= face at resolution), not a loss.
		let soldLegs = 0;
		for (const leg of opp.legs) {
			try {
				await this.sellLeg(leg);
				soldLegs++;
			} catch (err) {
				console.error(
					`mint-sell: minted set but leg ${soldLegs + 1}/${opp.legs.length} did not sell ` +
						`(${(err as Error).message}). Holding redeemable tokens; complete or redeem manually.`,
				);
			}
		}
		const proceeds = opp.legs.reduce((s, l) => s + l.cost, 0);
		console.log(`  sold ${soldLegs}/${opp.legs.length} legs for ~$${proceeds.toFixed(2)}`);
		return {
			executed: soldLegs === opp.legs.length,
			filledLegs: soldLegs,
			spentUsd: opp.shares, // $1 per minted set
		};
	}
}

type Hex = `0x${string}`;
