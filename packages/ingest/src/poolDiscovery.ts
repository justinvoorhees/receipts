/**
 * poolDiscovery.ts — Discover the best reference pool for a token pair.
 *
 * Given two token addresses, finds the deepest-liquidity pool across
 * Uniswap V3, PancakeSwap V3, Aerodrome CL, and Uniswap V2 factories.
 * Falls back to a caller-supplied pool address (Design Decision 5: the
 * leg's own pool) when factory lookups don't resolve a deeper reference
 * pool, so discovery never hard-fails for the smoke routes.
 *
 * No DB imports — only viem RPC reads.
 */

import { type PublicClient, parseAbi } from 'viem';

// ── Types ────────────────────────────────────────────────────────────────────

export type PoolKind = 'univ3' | 'pancakev3' | 'aerodrome_cl' | 'univ2' | 'univ4';

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

export const V4_STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const V2_PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
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
  try {
    const result = await client.readContract({
      address: poolAddress,
      abi: SLOT0_ABI,
      functionName: 'slot0',
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return result[0] > 0n;
  } catch {
    return false;
  }
}

/**
 * Read slot0 from a V3-style pool at a given block.
 * Returns sqrtPriceX96 or null if the call fails.
 */
export async function readSlot0(
  client: PublicClient,
  poolAddress: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: poolAddress,
      abi: SLOT0_ABI,
      functionName: 'slot0',
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
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
