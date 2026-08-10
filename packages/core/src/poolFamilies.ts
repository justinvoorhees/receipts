/**
 * poolFamilies.ts — registry of pool "families" for reference-pool discovery.
 *
 * Each family owns its factory address(es), the parameter axis it scans
 * (V3 fee tiers, CL tick spacings, Solidly stable flags), and a `mechanism`
 * tag that tells discovery + pricing how to gate/read the pool: `v3-slot0`
 * (read slot0 sqrtPriceX96) or `v2-reserves` (read getReserves). Adding a new
 * pool type is a single POOL_FAMILIES entry — no edits to the ranker or the
 * mid reader.
 */
import { type PublicClient, parseAbi } from 'viem';
import type { PoolKind } from './poolDiscovery.js';
import { anchorRank } from './receiptPure.js';

export type PoolMechanism = 'v3-slot0' | 'v2-reserves';

const V2_MECHANISM_KINDS: readonly PoolKind[] = ['aerodrome_basic', 'univ2'];

/** How a pool of `kind` is initialized-gated and priced. */
export function mechanismForKind(kind: PoolKind): PoolMechanism {
	return V2_MECHANISM_KINDS.includes(kind) ? 'v2-reserves' : 'v3-slot0';
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The pool member used as the uniform depth yardstick: the stronger anchor
 * (stable > WETH > volatile). On an anchor tie the lexicographically greater
 * address wins so discovery is order-independent in (a, b).
 */
export function pickReferenceToken(a: string, b: string): `0x${string}` {
	const la = a.toLowerCase() as `0x${string}`;
	const lb = b.toLowerCase() as `0x${string}`;
	const ra = anchorRank(la);
	const rb = anchorRank(lb);
	if (ra !== rb) return ra > rb ? la : lb;
	return la > lb ? la : lb;
}

export interface PoolFamily {
	kind: PoolKind;
	mechanism: PoolMechanism;
	/** Candidate pool addresses for (a, b); may include uninitialized pools. */
	discover(client: PublicClient, a: string, b: string, block?: bigint): Promise<`0x${string}`[]>;
}

// ── Factory addresses (Base mainnet, confirmed on-chain) ─────────────────────
const UNIV3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as const;
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;
const AERO_CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' as const;
/** Aerodrome basic PoolFactory — factory() of 0x5fb5a087… (verified 2026-07-22). */
const AERO_BASIC_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const;

const V3_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);
const AERO_CL_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)',
]);
const SOLIDLY_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, bool stable) view returns (address pool)',
]);

const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];
const AERO_TICK_SPACINGS: readonly number[] = [1, 50, 100, 200];
const SOLIDLY_STABLE_FLAGS: readonly boolean[] = [false, true];

async function scanGetPool<T>(
	client: PublicClient,
	factory: `0x${string}`,
	abi: typeof V3_FACTORY_ABI | typeof AERO_CL_FACTORY_ABI | typeof SOLIDLY_FACTORY_ABI,
	a: string,
	b: string,
	params: readonly T[],
): Promise<`0x${string}`[]> {
	const la = a.toLowerCase() as `0x${string}`;
	const lb = b.toLowerCase() as `0x${string}`;

	// Every tier/spacing is an independent lookup, so they go out together. One
	// pair costs 14 of these across the four families, and they were serial.
	const found = await Promise.all(
		params.map(async (p) => {
			try {
				return (await client.readContract({
					address: factory, abi, functionName: 'getPool', args: [la, lb, p],
				} as never)) as `0x${string}`;
			} catch {
				// factory reverts for a missing tier/variant — skip
				return null;
			}
		}),
	);

	// Filtered in DECLARED parameter order, not completion order:
	// rankCandidatesByDepth breaks a depth tie by position, so returning these in
	// whatever order the RPC happened to answer would make pool selection depend
	// on network timing.
	return found.filter((pool): pool is `0x${string}` => pool != null && pool !== ZERO_ADDRESS);
}

export const POOL_FAMILIES: PoolFamily[] = [
	{ kind: 'univ3', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, UNIV3_FACTORY, V3_FACTORY_ABI, a, b, V3_FEE_TIERS) },
	{ kind: 'pancakev3', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, PANCAKE_V3_FACTORY, V3_FACTORY_ABI, a, b, V3_FEE_TIERS) },
	{ kind: 'aerodrome_cl', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, AERO_CL_FACTORY, AERO_CL_FACTORY_ABI, a, b, AERO_TICK_SPACINGS) },
	{ kind: 'aerodrome_basic', mechanism: 'v2-reserves',
		discover: (c, a, b) => scanGetPool(c, AERO_BASIC_FACTORY, SOLIDLY_FACTORY_ABI, a, b, SOLIDLY_STABLE_FLAGS) },
];
