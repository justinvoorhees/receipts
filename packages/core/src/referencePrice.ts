import { sqrtPriceX96ToPrice } from './priceMath.js';

/**
 * The USDC/WETH specialization of the shared sqrtPrice conversion.
 *
 * This module also held `getReferencePrice`, which read a pool's slot0 at block
 * N-1 directly. Reference mids now come from the Market Price apparatus
 * (marketPrice.ts / pricing.ts), which reads slot0 through the pooled clients in
 * poolDiscovery, so that entry point was removed once nothing called it.
 */

export function sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96: bigint): number {
	// USDC/WETH is the `token0=WETH(18), token1=USDC(6)` case of the general
	// conversion: price = sqrtPriceX96^2 / 2^192 * 10^(18-6). Delegates to the
	// shared priceMath implementation (which carries 1e18 of internal precision —
	// strictly finer than the old 1e8, an accuracy improvement of ~1e-11 relative).
	return sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
}
