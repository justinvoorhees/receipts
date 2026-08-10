/**
 * poolDiscovery.ts — Discover the best reference pool for a token pair.
 *
 * Given two token addresses, finds the deepest-liquidity pool across
 * Uniswap V3, PancakeSwap V3, and Aerodrome CL factories, plus the Aerodrome
 * basic-AMM (Solidly `getReserves`) family. `univ2` is reserved in the
 * `PoolKind` union for a future basic-AMM family entry but is not currently
 * scanned — only `aerodrome_basic` is wired into `POOL_FAMILIES` today.
 * Falls back to a caller-supplied pool address (Design Decision 5: the
 * leg's own pool) when factory lookups don't resolve a deeper reference
 * pool, so discovery never hard-fails for the smoke routes.
 *
 * No DB imports — only viem RPC reads.
 */

import { type PublicClient, parseAbi, parseAbiItem } from 'viem';
import { POOL_FAMILIES, mechanismForKind, pickReferenceToken } from './poolFamilies.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type PoolKind = 'univ3' | 'pancakev3' | 'aerodrome_cl' | 'aerodrome_basic' | 'univ2' | 'univ4';

export interface DiscoveredPool {
  address: `0x${string}`;
  kind: PoolKind;
  /** For V4, the poolId needed for StateView queries. */
  v4PoolId?: `0x${string}`;
}

// ── Factory addresses (Base mainnet, confirmed on-chain) ─────────────────────

/** Uniswap V3 factory — confirmed via getPool(WETH, USDC, 500) → 0xd0b53D92… */
const UNIV3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as const;

/** PancakeSwap V3 factory — confirmed via getPool(USDC, VIRTUAL, 500) → 0x7CB770D0… */
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;

/** Aerodrome CL factory — confirmed via getPool(WETH, USDC, 1) → 0xdbc699… */
const AERO_CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' as const;

/** Uniswap V4 StateView (reads slot0 by poolId) — confirmed on-chain Step 0 */
export const V4_STATE_VIEW = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71' as const;

/** Uniswap V4 PoolManager */
export const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b' as const;

// ── ABIs ─────────────────────────────────────────────────────────────────────

const V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const AERO_CL_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)',
]);

const SLOT0_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

// Aerodrome CL and some other V3 forks omit feeProtocol, returning 6 values instead of 7.
const SLOT0_NO_FEE_PROTOCOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
]);

export const V4_STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const V2_PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

const POOL_LIQUIDITY_ABI = parseAbi([
  'function liquidity() view returns (uint128)',
]);

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

// ── Fee tiers to scan ────────────────────────────────────────────────────────

/** Standard Uniswap V3 fee tiers (in hundredths of a bps, i.e. raw units). */
const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

/** Aerodrome CL tick spacings to scan. */
const AERO_TICK_SPACINGS: readonly number[] = [1, 50, 100, 200];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── Core discovery ───────────────────────────────────────────────────────────

/**
 * Discover the best reference pool for a token pair across known factories.
 *
 * Tries Uniswap V3, PancakeSwap V3, and Aerodrome CL factories across
 * standard fee tiers / tick spacings. Returns the first pool found with
 * a non-zero sqrtPriceX96 (i.e. initialized). If no factory pool is found,
 * returns `null` — the caller should fall back to the leg's own pool.
 */
export async function discoverPool(
  client: PublicClient,
  tokenA: string,
  tokenB: string,
  blockNumber?: bigint,
): Promise<DiscoveredPool | null> {
  const a = tokenA.toLowerCase() as `0x${string}`;
  const b = tokenB.toLowerCase() as `0x${string}`;

  // Try V3-style factories (Uniswap V3, PancakeSwap V3) across fee tiers
  const v3Factories: { address: `0x${string}`; kind: PoolKind }[] = [
    { address: UNIV3_FACTORY, kind: 'univ3' },
    { address: PANCAKE_V3_FACTORY, kind: 'pancakev3' },
  ];

  for (const factory of v3Factories) {
    for (const fee of V3_FEE_TIERS) {
      try {
        const poolAddr = await client.readContract({
          address: factory.address,
          abi: V3_FACTORY_ABI,
          functionName: 'getPool',
          args: [a, b, fee],
        });
        if (poolAddr && poolAddr !== ZERO_ADDRESS) {
          // Verify pool is initialized by checking slot0
          const isInit = await isPoolInitialized(client, poolAddr as `0x${string}`, blockNumber);
          if (isInit) {
            return { address: poolAddr as `0x${string}`, kind: factory.kind };
          }
        }
      } catch {
        // Factory call failed — skip this tier
      }
    }
  }

  // Try Aerodrome CL factory across tick spacings
  for (const tickSpacing of AERO_TICK_SPACINGS) {
    try {
      const poolAddr = await client.readContract({
        address: AERO_CL_FACTORY,
        abi: AERO_CL_FACTORY_ABI,
        functionName: 'getPool',
        args: [a, b, tickSpacing],
      });
      if (poolAddr && poolAddr !== ZERO_ADDRESS) {
        const isInit = await isPoolInitialized(client, poolAddr as `0x${string}`, blockNumber);
        if (isInit) {
          return { address: poolAddr as `0x${string}`, kind: 'aerodrome_cl' };
        }
      }
    } catch {
      // Skip
    }
  }

  return null;
}

/**
 * Check if a V3-style pool is initialized by reading slot0.
 * Returns true if sqrtPriceX96 > 0.
 */
async function isPoolInitialized(
  client: PublicClient,
  poolAddress: `0x${string}`,
  blockNumber?: bigint,
): Promise<boolean> {
  const sqrtPriceX96 = await readSlot0(client, poolAddress, blockNumber);
  return sqrtPriceX96 !== null && sqrtPriceX96 > 0n;
}

/**
 * Read slot0 from a V3-style pool at a given block.
 * Tries the standard 7-value ABI first; falls back to the 6-value ABI used by
 * Aerodrome CL and other forks that omit feeProtocol.
 * Returns sqrtPriceX96 or null if both calls fail.
 */
export async function readSlot0(
  client: PublicClient,
  poolAddress: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  const opts = { address: poolAddress, functionName: 'slot0', ...(blockNumber !== undefined ? { blockNumber } : {})} as const;
  try {
    const result = await client.readContract({ ...opts, abi: SLOT0_ABI });
    return result[0] > 0n ? result[0] : null;
  } catch {
    // Fall back to 6-value ABI (no feeProtocol)
  }
  try {
    const result = await client.readContract({ ...opts, abi: SLOT0_NO_FEE_PROTOCOL_ABI });
    return result[0] > 0n ? result[0] : null;
  } catch {
    return null;
  }
}

/**
 * Read slot0 from a Uniswap V4 pool via StateView at a given block.
 * Returns sqrtPriceX96 or null if the call fails.
 */
export async function readV4Slot0(
  client: PublicClient,
  poolId: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: V4_STATE_VIEW,
      abi: V4_STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return result[0] > 0n ? result[0] : null;
  } catch {
    return null;
  }
}

/** PancakeSwap Infinity CLPoolManager — emits Swap AND answers state reads. */
export const INFINITY_CL_POOL_MANAGER = '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as const;

const INFINITY_CL_ABI = [
  parseAbiItem(
    'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ),
  parseAbiItem(
    'function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)',
  ),
] as const;

/**
 * Read slot0 for an Infinity pool at a given block. Returns sqrtPriceX96 or null.
 *
 * ⚠️ Called on the CLPoolManager ITSELF. Uniswap V4 needs a separate StateView
 * contract for this; Infinity does not, and there is no Infinity StateView to
 * go looking for.
 */
export async function readInfinitySlot0(
  client: PublicClient,
  poolId: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: INFINITY_CL_POOL_MANAGER,
      abi: INFINITY_CL_ABI,
      functionName: 'getSlot0',
      args: [poolId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return result[0] > 0n ? result[0] : null;
  } catch {
    return null;
  }
}

/** Read an Infinity pool's two currencies at a given block, or null. */
export async function readInfinityPoolKey(
  client: PublicClient,
  poolId: `0x${string}`,
  blockNumber?: bigint,
): Promise<{ currency0: string; currency1: string } | null> {
  try {
    const r = await client.readContract({
      address: INFINITY_CL_POOL_MANAGER,
      abi: INFINITY_CL_ABI,
      functionName: 'poolIdToPoolKey',
      args: [poolId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return { currency0: r[0], currency1: r[1] };
  } catch {
    return null;
  }
}

/**
 * Read the in-range `liquidity()` from a V3-style pool at a given block.
 * Returns the liquidity (uint128) or null on revert/error. Used only to RANK
 * candidate pools by depth — never for pricing.
 */
export async function readLiquidity(
  client: PublicClient,
  poolAddress: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: poolAddress,
      abi: POOL_LIQUIDITY_ABI,
      functionName: 'liquidity',
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return result;
  } catch {
    return null;
  }
}

export type PoolCandidate = { address: `0x${string}`; kind: PoolKind };

export interface RankReaders {
  isInitialized(c: PoolCandidate): Promise<boolean>;
  readDepth(c: PoolCandidate): Promise<bigint>;
}

/**
 * Rank candidate pools across families by one uniform depth yardstick, keeping
 * only initialized pools. Pure over injected readers so it is unit-testable
 * without a live client. Unreadable depth ⇒ 0 (caller's readDepth policy), so a
 * pool is never dropped purely because its depth read reverted.
 */
export async function rankCandidatesByDepth(
  candidates: PoolCandidate[],
  readers: RankReaders,
): Promise<{ pool: DiscoveredPool; depth: bigint } | null> {
  // Candidates are scored in parallel — this is the hot loop of discovery (two
  // reads each, ~17 candidates per pair), and against the production endpoint a
  // serial read costs ~85ms where twenty concurrent ones cost ~5ms each.
  //
  // The two reads for ONE candidate stay ordered: `readDepth` is only meaningful
  // for an initialized pool, and firing it speculatively would spend an extra
  // RPC call on every dead fee tier.
  const scored = await Promise.all(
    candidates.map(async (cand) => {
      if (!(await readers.isInitialized(cand))) return null;
      return { pool: { address: cand.address, kind: cand.kind }, depth: await readers.readDepth(cand) };
    }),
  );

  // Reduced in the ORIGINAL candidate order with a strict `>`, so a depth tie is
  // still won by the earlier candidate. Picking the winner as results arrive
  // would make pool selection depend on which read resolved first.
  let best: { pool: DiscoveredPool; depth: bigint } | null = null;
  for (const cand of scored) {
    if (cand !== null && (best === null || cand.depth > best.depth)) best = cand;
  }
  return best;
}

/** ERC-20 balanceOf a holder; 0n on revert. Used only to rank pool depth. */
export async function readErc20Balance(
  client: PublicClient,
  token: string,
  holder: string,
  blockNumber?: bigint,
): Promise<bigint> {
  try {
    return await client.readContract({
      address: token.toLowerCase() as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [holder.toLowerCase() as `0x${string}`],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
  } catch {
    return 0n;
  }
}

/**
 * Discover the DEEPEST initialized reference pool for an arbitrary token pair.
 *
 * Unlike `discoverPool` (which returns the first initialized pool found and is
 * relied on unchanged by existing callers), this gathers candidates across
 * every family in `POOL_FAMILIES` — V3-style pools (Uniswap V3, PancakeSwap
 * V3, Aerodrome CL) plus the basic-AMM family currently discovered (Aerodrome
 * basic) — then ranks the initialized candidates by a uniform
 * `balanceOf(referenceToken)` depth yardstick and returns the deepest.
 * This is the reference pool a generic pair-mid should be sampled from.
 *
 * Each family's mechanism (`v3-slot0` vs `v2-reserves`) determines how it is
 * gated for initialization: V3-style via `readSlot0`, basic AMM via
 * `readV2Reserves`. Returns `null` when no initialized pool exists for the
 * pair.
 *
 * NEVER throws: individual factory / reserve / balance reads are wrapped so a
 * transient RPC failure on one candidate just drops that candidate.
 */
export async function getDeepestPoolWithDepth(
  client: PublicClient,
  tokenA: string,
  tokenB: string,
  blockNumber?: bigint,
): Promise<{ pool: DiscoveredPool; depth: bigint } | null> {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  const refToken = pickReferenceToken(a, b);

  // Gather candidates from every family. The families are independent, so their
  // factory scans go out together; flattened in POOL_FAMILIES order afterwards,
  // because candidate position is the tie-break in rankCandidatesByDepth below.
  const perFamily = await Promise.all(
    POOL_FAMILIES.map(async (fam) =>
      (await fam.discover(client, a, b, blockNumber)).map((addr) => ({ address: addr, kind: fam.kind })),
    ),
  );
  const candidates: PoolCandidate[] = perFamily.flat();

  return rankCandidatesByDepth(candidates, {
    isInitialized: async (c) => {
      if (mechanismForKind(c.kind) === 'v2-reserves') {
        const r = await readV2Reserves(client, c.address, blockNumber);
        return r !== null && r[0] > 0n && r[1] > 0n;
      }
      const sqrt = await readSlot0(client, c.address, blockNumber);
      return sqrt !== null && sqrt > 0n;
    },
    readDepth: (c) => readErc20Balance(client, refToken, c.address, blockNumber),
  });
}

/**
 * Same discovery/ranking as `getDeepestPoolWithDepth` but returns only the pool
 * (back-compat for callers that don't need depth).
 */
export async function getDeepestPoolForPair(
  client: PublicClient,
  tokenA: string,
  tokenB: string,
  blockNumber?: bigint,
): Promise<DiscoveredPool | null> {
  const best = await getDeepestPoolWithDepth(client, tokenA, tokenB, blockNumber);
  return best?.pool ?? null;
}

/**
 * Read reserves from a V2-style pair at a given block.
 * Returns [reserve0, reserve1] or null if the call fails.
 */
export async function readV2Reserves(
  client: PublicClient,
  pairAddress: `0x${string}`,
  blockNumber?: bigint,
): Promise<[bigint, bigint] | null> {
  try {
    const result = await client.readContract({
      address: pairAddress,
      abi: V2_PAIR_ABI,
      functionName: 'getReserves',
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    if (result[0] === 0n && result[1] === 0n) return null;
    return [result[0], result[1]];
  } catch {
    return null;
  }
}
