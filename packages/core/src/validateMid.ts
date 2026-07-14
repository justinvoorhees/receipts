/**
 * Mid validation (Phase 2).
 *
 * A benchmark `marketMid` for a single-anchor pair is only as trustworthy as the
 * (often bridged, non-oracle) reference it came from. Before the dashboard marks
 * the non-anchored side at that mid, we corroborate it against one or more sources
 * that are INDEPENDENT of the executed swap — a prior-window on-chain TWAP, an
 * independent reference pool, or an off-chain feed. Agreement within tolerance on
 * any one source is enough to validate.
 *
 * This module is the pure comparison core (mirroring `computeBenchmark`). Fetching
 * corroborator prices (RPC/HTTP) is impure and lives behind an injectable seam;
 * callers must normalize every corroborator to the SAME orientation as `spotMid`
 * (quote-per-base) before passing them here.
 */

/** Agreement tolerance in bps — looser than the 50 bps WETH/USDC manipulation bar,
 *  reflecting tail-token volatility. Tunable. */
export const MID_VALIDATION_TOL_BPS = 100;

export interface MidCorroborator {
	source: string;
	/** Price in the same orientation as `spotMid`, or null when unavailable. */
	price: number | null;
}

export interface MidValidationResult {
	validated: boolean;
	/** Sources whose price agreed with `spotMid` within tolerance. */
	agreeing: string[];
	/** Deviation (bps) of the CLOSEST usable corroborator, or null if none. */
	devBps: number | null;
}

export function validateMid(
	spotMid: number,
	corroborators: MidCorroborator[],
	tolBps: number = MID_VALIDATION_TOL_BPS,
): MidValidationResult {
	if (!Number.isFinite(spotMid) || spotMid <= 0) {
		return { validated: false, agreeing: [], devBps: null };
	}
	const agreeing: string[] = [];
	let closest: number | null = null;
	for (const { source, price } of corroborators) {
		if (price == null || !Number.isFinite(price) || price <= 0) continue;
		const devBps = (Math.abs(spotMid - price) / price) * 10_000;
		if (closest == null || devBps < closest) closest = devBps;
		if (devBps <= tolBps) agreeing.push(source);
	}
	return { validated: agreeing.length > 0, agreeing, devBps: closest };
}
