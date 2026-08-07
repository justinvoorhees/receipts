/**
 * resolveAggregator.ts — who did the taker actually trade with?
 *
 * Precedence (Design Decision 1):
 *   1. Resolver — `to` is in the 0x Deployer registry set (configs/settlers.json)
 *   2. Address  — `to` is a curated router (configs/routers.json)
 *   3. Unknown  — no guess; emit a triage hint carrying any topic evidence
 *
 * Note this INVERTS the venue chain (topic → factory() → address list). For
 * venues the pool address is the thing. For aggregators, `to` is the thing:
 * it is the contract the taker called, and therefore IS the aggregator they
 * used. Settlement topics are evidence about who is INSIDE the trade, and
 * aggregators nest — trade 0xb02037…9e26 has a Bebop settlement inside a 0x
 * route. Topic-based identity cannot tell "Nordstern shipped a new router"
 * from "a new meta-aggregator routes through Nordstern"; both are "unknown
 * `to` + known inner topic". So topics never label. A wrong attribution is
 * worse than `unknown`: `unknown` is honest and gets triaged.
 *
 * Both auto-labeling tiers are declarations, not inferences — 0x publishes its
 * own Settler addresses on-chain, and routers.json is human-verified.
 *
 * Synchronous by contract: analyzeTransaction.ts calls this inline.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSettlerRegistry, type SettlerRegistry } from './settlerRegistry.js';
import { findAggregatorHints } from './aggregatorSignatures.js';
import { labelAddress } from './tagging.js';
import { log } from './log.js';

export type DetectedVia = 'resolver' | 'address' | 'unknown';

import type { TraceNode } from './tradeEndpoints.js';

export interface AggregatorResolution {
	/** Display name: '0x', 'KyberSwap', or the raw address when unknown. */
	label: string;
	/** Lowercased label — the AGGREGATOR_SIGNATURES key. */
	slug: string;
	detectedVia: DetectedVia;
	/** Aggregator slugs whose settlement topic appears in the logs. Populated
	 *  ONLY when detectedVia === 'unknown'; a hint is never an identity. */
	hints: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTLERS_CONFIG_PATH = path.resolve(__dirname, '../../../configs/settlers.json');

let settlerRegistry: SettlerRegistry;
try {
	settlerRegistry = await loadSettlerRegistry(SETTLERS_CONFIG_PATH);
} catch (err) {
	// Degrade to "no known settlers" rather than throw — resolveAggregator must
	// never fail. Mirrors tagging.ts's contract. But warn: silently resolving
	// every 0x trade to unknown is precisely the bug this module exists to fix,
	// so a missing/misplaced config must not be invisible.
	log.warn('could not load settler registry, 0x Settler trades will not resolve', {
		module: 'resolveAggregator',
		path: SETTLERS_CONFIG_PATH,
		error: err instanceof Error ? err.message : String(err),
	});
	settlerRegistry = { byAddressLower: new Map(), all: [] };
}

export function resolveAggregator(
	to: string | null,
	logs: readonly { address: string; topics: readonly string[] }[],
): AggregatorResolution {
	if (!to) return { label: 'unknown', slug: 'unknown', detectedVia: 'unknown', hints: [] };

	const lower = to.toLowerCase();

	// Tier 1: the aggregator declares this address as its own, on-chain.
	const settler = settlerRegistry.byAddressLower.get(lower);
	if (settler) {
		return {
			label: settler.aggregator,
			slug: settler.aggregator.toLowerCase(),
			detectedVia: 'resolver',
			hints: [],
		};
	}

	// Tier 2: curated, human-verified.
	const labeled = labelAddress(to);
	if (labeled.kind === 'router') {
		return {
			label: labeled.label,
			slug: labeled.label.toLowerCase(),
			detectedVia: 'address',
			hints: [],
		};
	}

	// Tier 3: no guess.
	return { label: to, slug: lower, detectedVia: 'unknown', hints: findAggregatorHints(logs) };
}

/**
 * Every CALL target in a callTracer tree, shallowest-first and deduped.
 *
 * Only true CALL frames are collected: a DELEGATECALL/STATICCALL target is an
 * implementation or a read, never a router the trade was routed *through*.
 * Breadth-first ordering is load-bearing — the OUTERMOST registered router is
 * the aggregator the user actually transacted with, and any router it calls in
 * turn is a downstream liquidity source, not the counterparty. (Relay's approval
 * proxy calling Fabric's router must resolve to Relay, not Fabric.)
 */
export function callTargetsByDepth(trace: TraceNode): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let level: TraceNode[] = [trace];
	while (level.length) {
		const next: TraceNode[] = [];
		for (const n of level) {
			const type = (n.type ?? 'CALL').toUpperCase();
			if (type === 'CALL' && n.to) {
				const a = n.to.toLowerCase();
				if (!seen.has(a)) { seen.add(a); out.push(a); }
			}
			for (const c of n.calls ?? []) next.push(c);
		}
		level = next;
	}
	return out;
}

/**
 * resolveAggregator, but tolerant of a transaction whose entry point is not a
 * router.
 *
 * `tx.to` is the router for an ordinary swap, but NOT when the trader's own
 * account is the entry point (an EIP-7702 delegated EOA self-calling `execute`)
 * or when a bundler submits through an ERC-4337 EntryPoint. In those cases the
 * plain resolution labels the user's wallet or the EntryPoint as the aggregator.
 *
 * ADDITIVE: when `to` resolves to a known aggregator this returns exactly what
 * resolveAggregator returns and never inspects the trace, so no working receipt
 * changes. Only registered routers/settlers can win — an unrecognized address is
 * never promoted.
 *
 * FAIL-CLOSED: the trace is walked ONLY when `to` is provably not a router, i.e.
 * it appears in `notRouters`. An unrecognized CONTRACT entry point is left
 * `unknown` on purpose — it may itself be an uncurated aggregator routing
 * through Fabric/0x, and naming it after its downstream liquidity source would
 * misattribute the trade. That case is what the AGGREGATOR_UNKNOWN_HINT triage
 * flag is for; resolving it is a human curation decision, not an inference.
 * (Receipts 250 / 487 / 488 are exactly this shape.)
 */
export function resolveAggregatorDeep(args: {
	to: string | null;
	logs: readonly { address: string; topics: readonly string[] }[];
	trace: TraceNode;
	/** Addresses that are provably NOT the aggregator, so the resolver may look
	 *  past them: the trader's own account and the known ERC-4337 EntryPoints. */
	notRouters?: ReadonlySet<string>;
}): AggregatorResolution & { matchedAddress: string | null } {
	const { to, logs, trace, notRouters } = args;
	const shallow = resolveAggregator(to, logs);
	if (shallow.detectedVia !== 'unknown') {
		return { ...shallow, matchedAddress: to ? to.toLowerCase() : null };
	}

	const skip = new Set([...(notRouters ?? [])].map((a) => a.toLowerCase()));
	// Only look past an entry point we can PROVE is not a router.
	if (!to || !skip.has(to.toLowerCase())) return { ...shallow, matchedAddress: null };
	skip.add(to.toLowerCase());

	for (const candidate of callTargetsByDepth(trace)) {
		if (skip.has(candidate)) continue;
		const r = resolveAggregator(candidate, logs);
		if (r.detectedVia !== 'unknown') return { ...r, matchedAddress: candidate };
	}
	// Nothing resolved: keep the original label/hints, and report no router
	// address rather than asserting the wallet or EntryPoint was one.
	return { ...shallow, matchedAddress: null };
}
