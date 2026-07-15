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

export type DetectedVia = 'resolver' | 'address' | 'unknown';

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
	console.warn(
		`[resolveAggregator] could not load ${SETTLERS_CONFIG_PATH} — 0x Settler trades will not resolve: ${err instanceof Error ? err.message : String(err)}`,
	);
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
