import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

/**
 * Reference price = the pool's marginal spot price at block N-1 (the block
 * before the trade settled). Spec §4.
 *
 * Computation:
 *   sqrtPriceX96 = (await pool.slot0()).sqrtPriceX96
 *   raw_price    = (sqrtPriceX96 / 2^96)^2
 *   USDC/WETH    = raw_price * (10^6 / 10^18)  // decimal adjustment
 *
 * `raw_price` from sqrtPriceX96 is in token1-per-token0 units. For the Base
 * USDC/WETH pool the token ordering is token0 = WETH (lower address),
 * token1 = USDC, so the raw price is already USDC-per-WETH at raw scale.
 * The `10^6 / 10^18` factor adjusts for the decimal difference between USDC
 * (6) and WETH (18).
 *
 * Requires archive RPC — Alchemy free tier returns "Requested resource not
 * found" on historical `eth_call`.
 */

const POOL_ABI = parseAbi([
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

export interface ReferencePriceArgs {
	rpcUrl: string;
	poolAddress: `0x${string}`;
	/** Trade block. Reference price is sampled at `blockNumber - 1`. */
	blockNumber: bigint;
}

export async function getReferencePrice(args: ReferencePriceArgs): Promise<number> {
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
	const result = await client.readContract({
		address: args.poolAddress,
		abi: POOL_ABI,
		functionName: 'slot0',
		blockNumber: args.blockNumber - 1n,
	});
	const sqrtPriceX96 = result[0];
	return sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96);
}

export function sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96: bigint): number {
	// `Number(sqrtPriceX96)` overflows IEEE 754 above ~2^53. Use scaled
	// arithmetic: square the bigint, then divide by 2^192, then apply the
	// 10^6 / 10^18 decimal factor as a single final scalar.
	const Q192 = 1n << 192n;
	const numerator = sqrtPriceX96 * sqrtPriceX96; // ≈ price * 2^192 at raw scale
	// Bring it into a Number-safe range by scaling down. We want
	// (numerator / Q192) * (1e6 / 1e18). That's numerator / (Q192 * 1e12).
	// Scale the bigint by 1e18 (carrying 18 decimals of precision) before
	// dividing, then convert to Number.
	const scaled = (numerator * 10n ** 18n) / Q192 / 10n ** 12n;
	return Number(scaled) / 1e18;
}
