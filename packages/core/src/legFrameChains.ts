/**
 * legFrameChains — which call frames did each venue get called from?
 *
 * A meta-aggregator can hand individual legs to another aggregator: on tx
 * 0x42fab3cd… the taker calls Relay, and both pool swaps execute inside
 * Fabric's Executor frame. The callTracer trace analyzeTransaction already
 * fetches carries that nesting; this module extracts it.
 *
 * DELIBERATELY REGISTRY-FREE. It emits raw addresses and never names anyone —
 * naming happens on read (resolveLegRouter.ts) so that adding a router to
 * configs/routers.json retroactively attributes every historical receipt that
 * ever touched it, with no repopulation. Putting a lookup here would trade
 * that away for nothing.
 *
 * A venue occurrence is ANY log whose emitter is a venue address — no
 * swap-topic filter. Maker (rfq) legs are identified by a fill topic and
 * transfer-discovered venues by no topic at all, so filtering on swap topics
 * would silently deny both any attribution.
 *
 * Nesting proves CONTAINMENT, not authorship: it shows whose contract the pool
 * call ran inside, not who chose the pool. Callers must not present it as
 * routing authorship.
 */
import type { TraceNode } from './tradeEndpoints.js';

/**
 * Max frames kept per chain — a bloat guard on route_legs, not a semantic
 * limit (deepest observed across the corpus is 3). Truncation keeps the
 * INNERMOST frames, since the innermost known router is the one displayed.
 */
const MAX_CHAIN = 12;

export function extractFrameChains(
	trace: TraceNode,
	venues: ReadonlySet<string>,
): Map<string, string[]> {
	// venue → the distinct chains it was reached by, JSON-encoded for set semantics.
	const observed = new Map<string, Set<string>>();

	const visit = (node: TraceNode, stack: readonly string[]): void => {
		const to = node.to?.toLowerCase();
		// Only CALL creates a frame: DELEGATECALL/STATICCALL execute in the
		// caller's context. Reverted frames did not happen. The venue itself is
		// never part of its own chain.
		const opensFrame =
			node.type === 'CALL' && to != null && to !== '' && !node.error && !venues.has(to);
		// Collapse CONSECUTIVE repeats: V4 runs
		// Executor → PoolManager.unlock → Executor.unlockCallback → PoolManager.swap,
		// and with PoolManager excluded the Executor would otherwise appear twice.
		const next =
			opensFrame && stack[stack.length - 1] !== to
				? [...stack, to].slice(-MAX_CHAIN)
				: stack;

		for (const entry of node.logs ?? []) {
			const emitter = entry.address.toLowerCase();
			if (!venues.has(emitter)) continue;
			let chains = observed.get(emitter);
			if (!chains) {
				chains = new Set();
				observed.set(emitter, chains);
			}
			chains.add(JSON.stringify(next));
		}

		for (const child of node.calls ?? []) visit(child, next);
	};
	visit(trace, []);

	const out = new Map<string, string[]>();
	for (const [venue, chains] of observed) {
		// Fail closed. One venue address reached by two different paths is
		// genuinely ambiguous — the V4 PoolManager singleton can host two pools
		// in one route, and legs join to frames by address, not log index.
		// Emitting nothing is honest; guessing is not.
		if (chains.size !== 1) continue;
		const chain = JSON.parse([...chains][0]!) as string[];
		if (chain.length > 0) out.set(venue, chain);
	}
	return out;
}
