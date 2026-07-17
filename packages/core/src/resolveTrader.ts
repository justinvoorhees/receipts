/**
 * resolveTrader — whose trade does this receipt describe?
 *
 * Precedence (mirrors resolveAggregator's tiering):
 *   1. self      — tx.from has a clean 1-in/1-out (today's path; short-circuits)
 *   2. uniswapx  — a UniswapX Fill names the swapper (authoritative)
 *   3. net-flow  — the proven sole-beneficiary detector (generic relayers)
 *   4. null      — no confidently-identified end-beneficiary (fail-closed)
 *
 * INVARIANTS (see the spec):
 *  - Additive: analyzeTransaction only calls this in place of `tx.from`, and
 *    tier 1 reproduces today's behavior, so no working receipt changes.
 *  - Fail-closed: tiers 2/3 return a party only when uniquely identified; on
 *    ambiguity they yield nothing and we fall through to null. Never anchors an
 *    intermediary leg.
 *  - self precedes protocol deliberately (preserves the additive guarantee); a
 *    filler that itself nets a clean swap anchors self — see spec Limitations.
 */
import { extractEndpoints, detectBeneficiaryByNetFlow, type TraceNode } from './endpoints.js';
import { decodeUniswapXBeneficiary, type LogLite } from './settlementDecoders.js';

export type Anchor = { kind: 'self' } | { kind: 'beneficiary'; method: 'uniswapx' | 'net-flow' };

export interface ResolveTraderArgs {
	trace: TraceNode;
	txFrom: string;
	logs: readonly LogLite[];
	reactors: ReadonlySet<string>;
	isEoa: (address: string) => Promise<boolean>;
}

export async function resolveTrader(
	args: ResolveTraderArgs,
): Promise<{ trader: string; anchor: Anchor } | null> {
	const { trace, txFrom, logs, reactors, isEoa } = args;
	const self = txFrom.toLowerCase();

	// Tier 1: self.
	if (extractEndpoints({ trace, trader: self })) return { trader: self, anchor: { kind: 'self' } };

	// Tier 2: UniswapX (authoritative).
	const swapper = decodeUniswapXBeneficiary(logs, reactors);
	if (swapper) return { trader: swapper, anchor: { kind: 'beneficiary', method: 'uniswapx' } };

	// Tier 3: net-flow.
	const detail = await detectBeneficiaryByNetFlow(trace, self, isEoa);
	if (detail) return { trader: detail.beneficiary.toLowerCase(), anchor: { kind: 'beneficiary', method: 'net-flow' } };

	// Tier 4: fail-closed.
	return null;
}

export function anchorFlags(anchor: Anchor): string[] {
	if (anchor.kind === 'self') return [];
	const flags = ['BENEFICIARY_ANCHORED: receipt anchored on the trade beneficiary, not the tx submitter'];
	if (anchor.method === 'uniswapx') flags.push('ANCHOR_VIA_UNISWAPX: swapper identified from the UniswapX Fill event');
	return flags;
}
