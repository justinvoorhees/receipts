/**
 * resolveLegRouter — which aggregator executed this leg?
 *
 * Read-time counterpart to legFrameChains.ts. Given a leg's raw frame chain
 * and the receipt's top-line aggregator, returns the innermost CURATED router
 * that is not the top line — or null.
 *
 * Resolution lives here, not in analysis, so that adding an address to
 * configs/routers.json retroactively attributes every historical receipt that
 * ever touched it. Note the registries are read once at module load (see
 * tagging.ts and resolveAggregator.ts), so a config edit needs a process
 * RESTART, not merely a page refresh.
 *
 * Only curated registries attribute. A corpus survey found that the unnamed
 * frames between aggregators and pools are overwhelmingly DEX periphery
 * routers (VelodromeSlipstreamRouter, SwapRouter) and aggregators' own
 * executors — not sub-aggregators. Naming those would be worse than silence.
 *
 * The result means EXECUTED BY, never route authorship: frame nesting proves
 * containment only. Do not aggregate it into "routed volume" claims.
 */
import { resolveAggregator } from './resolveAggregator.js';

export interface ResolvedLegRouter {
	/** Aggregator slug of the innermost known router (feeds formatProvider). */
	slug: string;
	/** That frame's contract address, lowercased — the Basescan link target. */
	address: string;
	/** Known routers in the chain, outermost→innermost, including the top line
	 *  when it is itself curated. Rendered as a tooltip only when longer than 2. */
	path: string[];
}

export function resolveLegRouter(
	frameChain: readonly string[] | undefined,
	topLevelSlug: string,
): ResolvedLegRouter | null {
	if (!frameChain || frameChain.length === 0) return null;

	const known: { slug: string; address: string }[] = [];
	for (const frame of frameChain) {
		// Empty logs: the argument only produces triage hints on the unknown
		// tier, which we discard anyway.
		const resolution = resolveAggregator(frame, []);
		if (resolution.detectedVia === 'unknown') continue;
		// One aggregator's own routers in sequence (Nordstern runs two) is one hop.
		if (known[known.length - 1]?.slug === resolution.slug) continue;
		known.push({ slug: resolution.slug, address: frame.toLowerCase() });
	}
	if (known.length === 0) return null;

	const innermost = known[known.length - 1]!;
	// Null when the innermost IS the top line. Covers the ordinary
	// single-aggregator trade (where a tag would be pure noise) and the
	// re-entry case Relay > Fabric > Relay, where Relay took the leg back —
	// there a real participant goes unmentioned, by decision.
	if (innermost.slug === topLevelSlug.toLowerCase()) return null;

	return {
		slug: innermost.slug,
		address: innermost.address,
		path: known.map((k) => k.slug),
	};
}
