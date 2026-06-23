import type { Direction } from './decoder.js';

/**
 * Signed deviation in basis points from `baselinePrice` to `comparePrice`,
 * direction-aware. Positive bps = cost paid by user (worse than baseline),
 * matching the ledger's convention.
 *
 *   sell_weth: user received USDC; lower compare price = fewer USDC out = cost
 *   buy_weth:  user paid USDC; higher compare price = more USDC in = cost
 *
 * Lifted out of processSwap.ts so the v2 trade-centric extractor and the v1
 * pipeline share one definition.
 */
export function signedDeviationBps(
	direction: Direction,
	baselinePrice: number,
	comparePrice: number,
): number {
	const deviation =
		direction === 'sell_weth'
			? baselinePrice - comparePrice
			: comparePrice - baselinePrice;
	return (deviation / baselinePrice) * 10_000;
}
