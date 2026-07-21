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

// ── Pool mid math (moved here from tokenPricing so referencePrice can share it) ──

/**
 * Convert a Uniswap V3/V4 sqrtPriceX96 to a human-readable price
 * (token1 per token0), adjusting for token decimals.
 *
 * Formula:
 *   raw_price = (sqrtPriceX96 / 2^96)^2        // token1_raw per token0_raw
 *   price     = raw_price * 10^(dec0 - dec1)    // human units
 *
 * Uses all-bigint arithmetic with a precision multiplier to avoid
 * IEEE 754 overflow (sqrtPriceX96 can exceed 2^53).
 */
export function sqrtPriceX96ToPrice(
	sqrtPriceX96: bigint,
	dec0: number,
	dec1: number,
): number {
	if (sqrtPriceX96 === 0n) return 0;

	const Q192 = 1n << 192n;
	const PRECISION = 10n ** 18n;

	const decDiff = dec0 - dec1;

	if (decDiff >= 0) {
		const DECIMAL_ADJUST = 10n ** BigInt(decDiff);
		const scaled = (sqrtPriceX96 * sqrtPriceX96 * DECIMAL_ADJUST * PRECISION) / Q192;
		return Number(scaled) / Number(PRECISION);
	} else {
		// Negative decimal difference: divide instead of multiply
		const DECIMAL_ADJUST = 10n ** BigInt(-decDiff);
		const scaled = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) / (Q192 * DECIMAL_ADJUST);
		return Number(scaled) / Number(PRECISION);
	}
}

/**
 * Compute a mid price from Uniswap V2-style reserves.
 *
 * Formula:
 *   raw_price = reserve1 / reserve0             // token1_raw per token0_raw
 *   price     = raw_price * 10^(dec0 - dec1)    // human units
 *
 * Returns 0 if reserve0 is zero.
 */
export function v2MidFromReserves(
	reserve0: bigint,
	reserve1: bigint,
	dec0: number,
	dec1: number,
): number {
	if (reserve0 === 0n) return 0;

	const PRECISION = 10n ** 18n;
	const decDiff = dec0 - dec1;

	if (decDiff >= 0) {
		const DECIMAL_ADJUST = 10n ** BigInt(decDiff);
		const scaled = (reserve1 * DECIMAL_ADJUST * PRECISION) / reserve0;
		return Number(scaled) / Number(PRECISION);
	} else {
		const DECIMAL_ADJUST = 10n ** BigInt(-decDiff);
		const scaled = (reserve1 * PRECISION) / (reserve0 * DECIMAL_ADJUST);
		return Number(scaled) / Number(PRECISION);
	}
}
