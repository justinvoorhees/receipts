import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

/**
 * Uniswap V3 QuoterV2 on Base. Used to simulate "what would the pool have
 * returned if our trade were the first thing to happen in block N" — i.e.,
 * the cleanest possible execution baseline given the pool state at block
 * N-1.
 *
 * The delta between this simulated `amountOut` and the actual on-chain
 * `amountOut` is everything the pool math does NOT explain — sandwich
 * attacks, within-block MEV ordering, frontruns. We call that slippage.
 *
 * The delta between the reference price and the simulated price, on the
 * other hand, is the pool's depth curve — price impact. Unavoidable for a
 * given trade size against a given liquidity profile.
 *
 * Address verified on-chain (eth_getCode + sample quoteExactInputSingle
 * round-trip against mainnet.base.org).
 */
export const QUOTER_V2_BASE: `0x${string}` = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

// `quoteExactInputSingle` non-state-changing simulation. The Quoter uses a
// revert-encoded pattern internally but viem handles it transparently when
// called via readContract.
const QUOTER_ABI = parseAbi([
	'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export interface QuoteArgs {
	rpcUrl: string;
	tokenIn: `0x${string}`;
	tokenOut: `0x${string}`;
	amountIn: bigint;
	feeTier: number;
	/**
	 * Simulate the pool state as of this block. For our use case it's the
	 * trade's block minus one — same snapshot we use for the reference price.
	 */
	blockNumber: bigint;
}

/**
 * Returns the `amountOut` the QuoterV2 would have produced at the start of
 * `blockNumber + 1`, given the pool state at `blockNumber`. Caller should
 * pass `blockNumber = tradeBlock - 1n` to match the reference-price snapshot.
 */
export async function simulateAmountOut(args: QuoteArgs): Promise<bigint> {
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
	const result = await client.simulateContract({
		address: QUOTER_V2_BASE,
		abi: QUOTER_ABI,
		functionName: 'quoteExactInputSingle',
		args: [
			{
				tokenIn: args.tokenIn,
				tokenOut: args.tokenOut,
				amountIn: args.amountIn,
				fee: args.feeTier,
				sqrtPriceLimitX96: 0n,
			},
		],
		blockNumber: args.blockNumber,
	});
	const [amountOut] = result.result;
	return amountOut;
}
