import type { FactCache } from './factCache.js';
import type { VenueType } from './routeGraph.js';
import type { V4PoolKeyReader } from './routeReaders.js';

/**
 * cachedReaders.ts — decorators that let a FactCache short-circuit a reader.
 *
 * Deliberately decorators rather than a `factCache` parameter threaded through
 * routeReaders.ts: the seven reader factories keep their signatures, and
 * decomposeRoute's existing `deps` seam is how these reach the decode.
 *
 * ⚠️ TWO RULES GOVERN EVERY DECORATOR HERE.
 *
 * 1. NEVER CACHE A NULL OR A DEFAULT. Every reader in routeReaders.ts turns a
 *    failed read into `null` or a defaulted value, and a failed read is
 *    indistinguishable from a nonexistent pool. That ambiguity has already
 *    corrupted receipts once. Caching one would make a transient blip
 *    permanent, across runs. Only positive results are stored.
 *
 * 2. ONLY IMMUTABLE FACTS. A v3 pool's fee() is fixed at creation. Hydrex and
 *    QuickSwap v4 are Algebra Integral — fee() returns the CURRENTLY EFFECTIVE
 *    fee including any plugin override — and v4/Infinity fees are hook-driven.
 *    Those are excluded by CACHEABLE_FEE_VENUES below, which is the whole
 *    safety argument for caching fees at all.
 *
 * `getPool` is not decorated here and must not be: it is a `latest`-tag factory
 * lookup whose answer changes when a new fee tier is deployed (rpcMemo.ts).
 *
 * `decimalsReader` is not decorated here either, deliberately. Decimals and
 * symbol are resolved by two separate readers, and writing a decimals-only
 * TokenFact would make a later symbol lookup a cache hit on a symbol nobody
 * read. Both are wired together in v0.2b-2. See factCache.ts's docstring.
 */

/**
 * Venues whose `fee()` is immutable per pool — the static-tier v3 forks, and
 * nothing else. Adding a venue here without confirming its fee cannot change is
 * how this cache starts serving wrong answers.
 */
export const CACHEABLE_FEE_VENUES: ReadonlySet<VenueType> = new Set<VenueType>([
	'univ3',
	'sushiv3',
	'baseswapv3',
	'pancakev3',
]);

/** poolId → currencies. The big win: ~25 serial `extsload` probes become zero. */
export function cachedPoolKeyReader(inner: V4PoolKeyReader, cache: FactCache): V4PoolKeyReader {
	return async (poolId: string) => {
		const hit = cache.getPoolKey(poolId);
		if (hit) return hit;
		const fresh = await inner(poolId);
		if (fresh) cache.setPoolKey(poolId, fresh);
		return fresh;
	};
}

type V3FactoryReader = (addr: string) => Promise<string | null> | string | null;

export function cachedV3FactoryReader(inner: V3FactoryReader, cache: FactCache): V3FactoryReader {
	return async (addr: string) => {
		const hit = cache.getPool(addr)?.factory;
		if (hit) return hit;
		const fresh = await inner(addr);
		if (fresh) cache.setPool(addr, { factory: fresh });
		return fresh;
	};
}

type FeeResult = { bps: number; defaulted: boolean };
type FeeReader = (addr: string, type: VenueType, feeRawPips?: number) => Promise<FeeResult> | FeeResult;

export function cachedFeeReader(inner: FeeReader, cache: FactCache): FeeReader {
	return async (addr: string, type: VenueType, feeRawPips?: number) => {
		if (!CACHEABLE_FEE_VENUES.has(type)) return inner(addr, type, feeRawPips);
		const hit = cache.getPool(addr)?.feeBps;
		if (hit !== undefined) return { bps: hit, defaulted: false };
		const fresh = await inner(addr, type, feeRawPips);
		// `defaulted` means the read FAILED and a fallback was substituted.
		if (!fresh.defaulted) cache.setPool(addr, { feeBps: fresh.bps });
		return fresh;
	};
}
