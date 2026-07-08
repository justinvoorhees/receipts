import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

/**
 * Reference price = the pool's marginal spot price at block N-1 (the block
 * before the trade settled). Spec §4.
 *
 * Computation:
 *   sqrtPriceX96 = (await pool.slot0()).sqrtPriceX96
 *   raw_price    = (sqrtPriceX96 / 2^96)^2          // token1_raw per token0_raw
 *   USDC/WETH    = raw_price * 10^(dec0 - dec1)     // = raw * 10^12 here
 *
 * NB: the spec writes the decimal correction as `10^6 / 10^18` — that's the
 * wrong direction for token0=WETH(18), token1=USDC(6). The standard Uniswap
 * V3 conversion is `raw_price * 10^(decimals_token0 - decimals_token1)`,
 * which for this pair is `* 10^12`. Reversing would give a price near zero
 * (and divide-by-zero downstream in the TCA ledger).
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
	// `Number(sqrtPriceX96)` overflows IEEE 754 precision above ~2^53; do all
	// multiplies as bigint and only convert at the end.
	//
	// Target: USDC_per_WETH = sqrtPriceX96^2 / 2^192 * 10^12
	// Carry an extra 1e8 of precision through bigint so the final Number cast
	// preserves cents-of-a-dollar accuracy at WETH prices up to six figures.
	const Q192 = 1n << 192n;
	const DECIMAL_ADJUST = 10n ** 12n; // 10^(decimals_token0 - decimals_token1)
	const PRECISION = 10n ** 8n;
	const scaled = (sqrtPriceX96 * sqrtPriceX96 * DECIMAL_ADJUST * PRECISION) / Q192;
	return Number(scaled) / Number(PRECISION);
}
