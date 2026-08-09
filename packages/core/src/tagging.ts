/**
 * tagging.ts — Pure address→label lookup for the receipt UI.
 *
 * Lifted from the retired §C Selection Gate (`selectionGate.ts`), which
 * embedded a hardcoded FEE_VAULTS map alongside its (now-deleted) gating
 * logic. That naming data is still valuable: the receipt UI surfaces these
 * labels so users see "Velora Fee Vault" instead of a raw 0x address.
 *
 * Merges the fee-sink map with the router registry (`routerRegistry.ts` /
 * `configs/routers.json`) so any address involved in a trade — fee sink,
 * router, or (future) known pool — can be labeled from one place.
 *
 * Pure, synchronous, read-only. Never throws — unknown addresses pass
 * through as their raw form.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadRouterRegistry, type RouterRegistry } from './routerRegistry.js';
import { log } from './log.js';

export type AddressKind = 'pool' | 'fee-sink' | 'router' | 'unknown';

export interface AddressLabel {
	label: string;
	kind: AddressKind;
}

// ─── Fee-sink map (lifted verbatim from selectionGate.ts's FEE_VAULTS) ───
// A fee vault is never the trader/pool — it's the aggregator's skim address.

const FEE_SINKS: Record<string, string> = {
	'0x00700052c0608f670705380a4900e0a8080010cc': 'Velora Fee Vault',
	'0xf70da97812cb96acdf810712aa562db8dfa3dbef': 'Relay Fee Vault',
};

// ─── Pool-identity map ───
// selectionGate.ts identified pools structurally (via Swap-event topics),
// not through a hardcoded name table, so there is no static pool map to
// lift. This is left empty and ready for future entries (e.g. curated
// USDC/WETH pool addresses with human-readable tier labels) without
// changing the labelAddress contract.

const POOL_NAMES: Record<string, string> = {};

// ─── Router registry (reused from routerRegistry.ts, not duplicated) ───
// loadRouterRegistry is async (reads configs/routers.json from disk), but
// labelAddress must be synchronous, so we resolve it once at module load
// via top-level await and cache the result for lookups.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTERS_CONFIG_PATH = path.resolve(__dirname, '../../../configs/routers.json');

let routerRegistry: RouterRegistry;
try {
	routerRegistry = await loadRouterRegistry(ROUTERS_CONFIG_PATH);
} catch (err) {
	// If the config can't be loaded (e.g. path moved, running outside the
	// repo checkout), degrade gracefully to "no known routers" rather than
	// throwing — labelAddress must never throw.
	//
	// But warn, for the same reason resolveAggregator.ts warns about the
	// settler registry: this is the registry that NAMES THE AGGREGATOR, via
	// resolveAggregator → labelAddress → here, and it is the only load site for
	// routers.json. Degrading quietly means every trade renders with no
	// attribution and nothing anywhere says why — a wrong receipt rather than a
	// missing one. ROUTERS_CONFIG_PATH is included because the likeliest cause
	// is the path itself: it is derived from import.meta.url, which webpack
	// bakes as a build-time absolute path (see README, Architecture notes).
	log.warn('could not load router registry, trades will not resolve to an aggregator', {
		module: 'tagging',
		path: ROUTERS_CONFIG_PATH,
		error: err instanceof Error ? err.message : String(err),
	});
	routerRegistry = { byAddressLower: new Map(), all: [] };
}

// ─── Public API ───

export function labelAddress(addr: string): AddressLabel {
	const lower = addr.toLowerCase();

	const feeSink = FEE_SINKS[lower];
	if (feeSink) return { label: feeSink, kind: 'fee-sink' };

	const pool = POOL_NAMES[lower];
	if (pool) return { label: pool, kind: 'pool' };

	const router = routerRegistry.byAddressLower.get(lower);
	if (router) return { label: router.name, kind: 'router' };

	return { label: addr, kind: 'unknown' };
}
