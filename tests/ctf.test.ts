import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
	encodeMergePositions,
	encodeSplitPosition,
	fullPartition,
	POLYGON_USDC,
	usdcBaseUnits,
	ZERO_BYTES32,
} from "../src/ctf.js";

const SPLIT_ABI = [
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
] as const;

const COND = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("usdcBaseUnits", () => {
	it("scales dollars to 6-decimal base units, rounding down", () => {
		expect(usdcBaseUnits(1)).toBe(1_000_000n);
		expect(usdcBaseUnits(12.345678)).toBe(12_345_678n);
		expect(usdcBaseUnits(0.0000019)).toBe(1n); // floor, never over-mint
	});

	it("rejects non-positive amounts", () => {
		expect(() => usdcBaseUnits(0)).toThrow();
		expect(() => usdcBaseUnits(-1)).toThrow();
	});
});

describe("fullPartition", () => {
	it("is [1,2] for a binary market", () => {
		expect(fullPartition(2)).toEqual([1n, 2n]);
	});
	it("covers the outcome space as singleton index sets", () => {
		expect(fullPartition(3)).toEqual([1n, 2n, 4n]);
	});
	it("rejects degenerate outcome counts", () => {
		expect(() => fullPartition(1)).toThrow();
	});
});

describe("encodeSplitPosition", () => {
	it("round-trips through the splitPosition ABI with correct args", () => {
		const data = encodeSplitPosition({ conditionId: COND, amount: 25 });
		const decoded = decodeFunctionData({ abi: SPLIT_ABI, data });
		expect(decoded.functionName).toBe("splitPosition");
		const [collateral, parent, conditionId, partition, amount] = decoded.args;
		expect((collateral as string).toLowerCase()).toBe(POLYGON_USDC.toLowerCase());
		expect(parent).toBe(ZERO_BYTES32);
		expect(conditionId).toBe(COND);
		expect(partition).toEqual([1n, 2n]);
		expect(amount).toBe(25_000_000n);
	});

	it("produces distinct selectors for split vs merge", () => {
		const split = encodeSplitPosition({ conditionId: COND, amount: 1 });
		const merge = encodeMergePositions({ conditionId: COND, amount: 1 });
		expect(split.slice(0, 10)).not.toBe(merge.slice(0, 10));
	});
});
