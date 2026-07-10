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

/**
 * Route-level implausibility cap for a mid-derived deviation. Beyond ±1000% the
 * number is definitionally a bad reference mid, not a real execution — no swap
 * fills 10x off mid. Mirrors decomposeRoute's per-leg PI_IMPLAUSIBLE_CAP_BPS,
 * one level up: a safety net so a garbage mid that slips past pool selection
 * (e.g. an empty boundary-tick pool) can never surface an absurd cost.
 */
export const IMPLAUSIBLE_DEVIATION_CAP_BPS = 100_000;

/** True when a mid-derived deviation is implausibly large (bad mid, not a real
 *  trade). Null (no mid) is not implausible — it's just absent. */
export function isImplausibleDeviationBps(bps: number | null): boolean {
	return bps != null && Math.abs(bps) > IMPLAUSIBLE_DEVIATION_CAP_BPS;
}
