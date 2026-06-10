import { encodeFunctionData, type Hex } from "viem";

/**
 * Gnosis Conditional Tokens Framework (CTF) helpers for the mint-and-sell arb.
 *
 * Splitting collateral mints a *complete set* — one of every outcome token —
 * from USDC: $1 of collateral becomes one YES + one NO for a binary market.
 * When the combined bids for YES+NO exceed $1, minting a set and selling both
 * legs is an immediate, riskless profit. This module builds the on-chain call
 * data; the irreversible broadcast lives in the gated MintSellExecutor.
 *
 * Addresses are Polygon mainnet (chain 137), the network Polymarket settles on.
 */
export const POLYGON_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
/** USDC.e — the collateral Polymarket markets are denominated in. */
export const POLYGON_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
/** Polymarket's NegRisk adapter, used to split markets flagged neg_risk. */
export const POLYGON_NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/** USDC has 6 decimals; convert a human share/dollar count to base units. */
export function usdcBaseUnits(amount: number): bigint {
	if (!(amount > 0)) throw new Error(`mint amount must be positive, got ${amount}`);
	// Round down to whole base units to never over-mint beyond the planned size.
	return BigInt(Math.floor(amount * 1_000_000));
}

/**
 * Partition for a market's outcomes. For a binary (YES/NO) market this is the
 * two singleton index sets [0b01, 0b10] = [1, 2]; their union covers the full
 * outcome space, which is what splitPosition requires for a complete-set mint.
 */
export function fullPartition(outcomeCount: number): bigint[] {
	if (outcomeCount < 2) throw new Error(`need >= 2 outcomes, got ${outcomeCount}`);
	const partition: bigint[] = [];
	for (let i = 0; i < outcomeCount; i++) partition.push(1n << BigInt(i));
	return partition;
}

const SPLIT_POSITION_ABI = [
	{
		name: "splitPosition",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "collateralToken", type: "address" },
			{ name: "parentCollectionId", type: "bytes32" },
			{ name: "conditionId", type: "bytes32" },
			{ name: "partition", type: "uint256[]" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [],
	},
	{
		name: "mergePositions",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "collateralToken", type: "address" },
			{ name: "parentCollectionId", type: "bytes32" },
			{ name: "conditionId", type: "bytes32" },
			{ name: "partition", type: "uint256[]" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [],
	},
] as const;

export interface SplitParams {
	conditionId: Hex;
	/** Human amount of complete sets to mint (1 set = 1 of each outcome). */
	amount: number;
	outcomeCount?: number;
	collateral?: Hex;
}

/** Encode a splitPosition call that mints `amount` complete sets from USDC. */
export function encodeSplitPosition(params: SplitParams): Hex {
	const outcomeCount = params.outcomeCount ?? 2;
	return encodeFunctionData({
		abi: SPLIT_POSITION_ABI,
		functionName: "splitPosition",
		args: [
			(params.collateral ?? POLYGON_USDC) as Hex,
			ZERO_BYTES32,
			params.conditionId,
			fullPartition(outcomeCount),
			usdcBaseUnits(params.amount),
		],
	});
}

/** Encode a mergePositions call (the inverse: complete set back to USDC). */
export function encodeMergePositions(params: SplitParams): Hex {
	const outcomeCount = params.outcomeCount ?? 2;
	return encodeFunctionData({
		abi: SPLIT_POSITION_ABI,
		functionName: "mergePositions",
		args: [
			(params.collateral ?? POLYGON_USDC) as Hex,
			ZERO_BYTES32,
			params.conditionId,
			fullPartition(outcomeCount),
			usdcBaseUnits(params.amount),
		],
	});
}
