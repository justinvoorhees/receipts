// Reference price = the pool's marginal spot price at block N-1 (the block
// before the trade settled). Spec §4.
//
//   sqrtPriceX96 = (await poolContract.read.slot0()).sqrtPriceX96
//   price = (Number(sqrtPriceX96) / 2**96) ** 2 * (10**6 / 10**18)
//   // USDC per WETH, accounting for the 6/18 decimal difference.
//
// Always use N-1, not N — at N the pool state already reflects the trade's
// own price impact.

export async function getReferencePrice(/* args */): Promise<number> {
	// TODO: viem `readContract` on the pool's slot0() with blockNumber = N-1.
	// Requires archive RPC (free Alchemy tier returns "Requested resource not found").
	throw new Error('Not yet implemented.');
}
