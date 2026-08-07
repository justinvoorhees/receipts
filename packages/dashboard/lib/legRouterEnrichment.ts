import { resolveAggregator, resolveLegRouter, type ResolvedLegRouter } from '@fabric-tca/core';

/** Per-leg shape persisted in receipts.route_legs jsonb. */
export interface RouteLeg {
	venue: string;
	type: string;
	tokenIn: string;
	tokenOut: string;
	feeTierBps: number;
	notionalUsdc: number;
	lpFeeBps: number | null;
	priceImpactBps: number | null;
	// Display symbols resolved + stored by core (analyzeTransaction). Optional:
	// absent on rows persisted before this was added, and on a leg token whose
	// on-chain symbol() read failed — both fall back to address-based resolution.
	tokenInSymbol?: string;
	tokenOutSymbol?: string;
	// Enclosing CALL frame addresses (outermost→innermost) for this leg's venue,
	// captured by core from the trace. Raw addresses — names are resolved on read
	// by resolveLegRouter so registry growth applies retroactively. Absent on
	// rows persisted before 2026-07-27 and on legs whose chain was ambiguous.
	frameChain?: string[];
	// False when core could not READ this pool's fee tier (the reader fell back
	// to 0). Omitted when the tier resolved, and absent on rows persisted before
	// 2026-07-30 — so only an explicit `false` suppresses the fee cell. Without
	// it a 0 bps fee would render as a confident "0.00bps", asserting the pool
	// was free rather than admitting we could not read it.
	feeResolved?: boolean;
	// The V4 singleton that emitted this leg's Swap. Present only on synthesized
	// per-pool legs, whose `venue` is `v4:<poolId>` rather than an address — link
	// to this, not to `venue`, or the Basescan URL is dead. Absent on rows
	// persisted before 2026-07-30 and on every non-V4 leg.
	v4Emitter?: string;
	// Resolved from `frameChain` on read (never persisted) — see
	// enrichLegRouters. Present only when another curated aggregator executed
	// this leg.
	router?: ResolvedLegRouter;
}

/**
 * Resolve each leg's `frameChain` into a named router, on read.
 *
 * Deliberately not done at analysis time: doing it here means adding an address
 * to configs/routers.json retroactively attributes every receipt, with no
 * repopulation. Runs server-side only — resolveLegRouter reads the registries
 * from disk and must never cross into a client bundle.
 *
 * Takes legs rather than a whole receipt. It only ever needed three values, and
 * a function that accepts a row is a function that cannot be called before a row
 * exists — which is precisely the situation once receipts stop being stored.
 */
export function enrichLegRouters(
	legs: unknown[] | null,
	topLevelRouter: string | null,
	aggregator: string | null,
): RouteLeg[] | null {
	if (!Array.isArray(legs)) return null;
	// Must resolve through the SAME registry snapshot that resolveLegRouter uses
	// for the leg side, not the label `aggregator` froze at analysis time. Those
	// two can diverge: an uncurated top-level address is recorded as its raw
	// lowercase string, but a later routers.json addition (or a rename) changes
	// what resolveAggregator returns for that same address today. If the top line
	// here stayed the stale label, the comparison in resolveLegRouter would stop
	// matching and a leg run by the SAME contract as the top line would get
	// wrongly tagged as a second aggregator the moment the registry grows —
	// turning a correct `null` into a false attribution.
	const topLevelSlug = topLevelRouter
		? resolveAggregator(topLevelRouter, []).slug
		: String(aggregator ?? '').toLowerCase();
	return (legs as RouteLeg[]).map((leg) => {
		const router = resolveLegRouter(leg.frameChain, topLevelSlug);
		return router ? { ...leg, router } : leg;
	});
}
