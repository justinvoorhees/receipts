/**
 * tokenPricing.ts — Generalized pair-mid pricing at block N-1.
 *
 * Provides:
 *   - sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1)  — pure math
 *   - v2MidFromReserves(r0, r1, dec0, dec1)          — pure math
 *   - makeDecimalsCache(rpcReader)                     — cached decimals
 *   - getPairMidAtBlock(client, tokenA, tokenB, block) — RPC-backed mid price
 *   - getTokenUsdcValue(client, token, amountRaw, block) — token→USDC valuation
 *
 * Generalizes `sqrtPriceX96ToUsdcPerWeth` from referencePrice.ts into a
 * decimal-parametric form. Uses the same all-bigint-then-cast technique
 * to avoid IEEE 754 overflow above 2^53.
 */

import { type PublicClient, parseAbi } from 'viem';
import {
  discoverPool,
  readSlot0,
  readV2Reserves,
  readV4Slot0,
} from './poolDiscovery.js';

// ── Constants ────────────────────────────────────────────────────────────────

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';

/** Known decimals — avoid RPC for common tokens. */
const KNOWN_DECIMALS: ReadonlyMap<string, number> = new Map([
  [USDC, 6],
  [WETH, 18],
]);

// ── Pure math ────────────────────────────────────────────────────────────────

/**
 * Convert a Uniswap V3/V4 sqrtPriceX96 to a human-readable price
 * (token1 per token0), adjusting for token decimals.
 *
 * Formula:
 *   raw_price = (sqrtPriceX96 / 2^96)^2        // token1_raw per token0_raw
 *   price     = raw_price * 10^(dec0 - dec1)    // human units
 *
 * Uses all-bigint arithmetic with a precision multiplier to avoid
 * IEEE 754 overflow (sqrtPriceX96 can exceed 2^53).
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number,
): number {
  if (sqrtPriceX96 === 0n) return 0;

  const Q192 = 1n << 192n;
  const PRECISION = 10n ** 18n;

  const decDiff = dec0 - dec1;

  if (decDiff >= 0) {
    const DECIMAL_ADJUST = 10n ** BigInt(decDiff);
    const scaled = (sqrtPriceX96 * sqrtPriceX96 * DECIMAL_ADJUST * PRECISION) / Q192;
    return Number(scaled) / Number(PRECISION);
  } else {
    // Negative decimal difference: divide instead of multiply
    const DECIMAL_ADJUST = 10n ** BigInt(-decDiff);
    const scaled = (sqrtPriceX96 * sqrtPriceX96 * PRECISION) / (Q192 * DECIMAL_ADJUST);
    return Number(scaled) / Number(PRECISION);
  }
}

/**
 * Compute a mid price from Uniswap V2-style reserves.
 *
 * Formula:
 *   raw_price = reserve1 / reserve0             // token1_raw per token0_raw
 *   price     = raw_price * 10^(dec0 - dec1)    // human units
 *
 * Returns 0 if reserve0 is zero.
 */
export function v2MidFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  dec0: number,
  dec1: number,
): number {
  if (reserve0 === 0n) return 0;

  const PRECISION = 10n ** 18n;
  const decDiff = dec0 - dec1;

  if (decDiff >= 0) {
    const DECIMAL_ADJUST = 10n ** BigInt(decDiff);
    const scaled = (reserve1 * DECIMAL_ADJUST * PRECISION) / reserve0;
    return Number(scaled) / Number(PRECISION);
  } else {
    const DECIMAL_ADJUST = 10n ** BigInt(-decDiff);
    const scaled = (reserve1 * PRECISION) / (reserve0 * DECIMAL_ADJUST);
    return Number(scaled) / Number(PRECISION);
  }
}

// ── Decimals cache ───────────────────────────────────────────────────────────

const ERC20_DECIMALS_ABI = parseAbi([
  'function decimals() view returns (uint8)',
]);

/**
 * Create a cached decimals reader. Known tokens (USDC, WETH) return
 * instantly without RPC. Unknown tokens call the provided reader once
 * and cache the result. Addresses are normalized to lowercase.
 */
export function makeDecimalsCache(
  rpcReader: (address: string) => Promise<number>,
): (address: string) => Promise<number> {
  const cache = new Map<string, number>();

  // Pre-seed with known tokens
  for (const [addr, dec] of KNOWN_DECIMALS) {
    cache.set(addr.toLowerCase(), dec);
  }

  return async (address: string): Promise<number> => {
    const key = address.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const decimals = await rpcReader(key);
    cache.set(key, decimals);
    return decimals;
  };
}

/**
 * Create a decimals cache backed by live RPC reads.
 */
export function makeRpcDecimalsCache(
  client: PublicClient,
): (address: string) => Promise<number> {
  return makeDecimalsCache(async (address: string) => {
    const result = await client.readContract({
      address: address as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    });
    return result;
  });
}

// ── RPC-backed pricing ───────────────────────────────────────────────────────

/**
 * Sort two token addresses into (token0, token1) order (Uniswap convention:
 * lower address is token0).
 */
function sortTokens(
  a: string,
  b: string,
): { token0: string; token1: string; inverted: boolean } {
  const aLc = a.toLowerCase();
  const bLc = b.toLowerCase();
  if (aLc < bLc) return { token0: aLc, token1: bLc, inverted: false };
  return { token0: bLc, token1: aLc, inverted: true };
}

export interface PairMidResult {
  /** Human price: tokenB per tokenA. */
  price: number;
  /** The pool used. */
  poolAddress: string;
  poolKind: string;
}

/**
 * Get the mid price of tokenA denominated in tokenB at a given block.
 *
 * Discovery priority:
 *   1. Factory lookup (UniV3 → PancakeV3 → Aerodrome CL)
 *   2. Fallback pool address (the leg's own pool)
 *
 * Returns the price as "tokenB per tokenA" (human units), or null if
 * no pool could be found or read.
 *
 * @param fallbackPool  Optional pool address to use if factory discovery fails
 *                      (Design Decision 5: the leg's own pool at block N-1).
 */
export async function getPairMidAtBlock(
  client: PublicClient,
  tokenA: string,
  tokenB: string,
  blockNumber: bigint,
  decimalsOf: (address: string) => Promise<number>,
  fallbackPool?: `0x${string}`,
): Promise<PairMidResult | null> {
  const { token0, token1, inverted } = sortTokens(tokenA, tokenB);

  const [dec0, dec1] = await Promise.all([
    decimalsOf(token0),
    decimalsOf(token1),
  ]);

  // 1. Try factory discovery
  const discovered = await discoverPool(client, token0, token1, blockNumber);

  if (discovered) {
    const sqrtPriceX96 = await readSlot0(client, discovered.address, blockNumber);
    if (sqrtPriceX96 !== null) {
      const rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
      // rawPrice is token1 per token0. If inverted, caller asked for
      // tokenA=token1, tokenB=token0 → need 1/rawPrice.
      const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
      return { price, poolAddress: discovered.address, poolKind: discovered.kind };
    }
  }

  // 2. Fallback to the leg's own pool address
  if (fallbackPool) {
    // Try as V3-style pool (slot0)
    const sqrtPriceX96 = await readSlot0(client, fallbackPool, blockNumber);
    if (sqrtPriceX96 !== null) {
      const rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
      const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
      return { price, poolAddress: fallbackPool, poolKind: 'fallback_v3' };
    }

    // Try as V2-style pair (getReserves)
    const reserves = await readV2Reserves(client, fallbackPool, blockNumber);
    if (reserves !== null) {
      const rawPrice = v2MidFromReserves(reserves[0], reserves[1], dec0, dec1);
      const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
      return { price, poolAddress: fallbackPool, poolKind: 'fallback_v2' };
    }
  }

  return null;
}

/**
 * Get the USDC value of a token amount at a given block.
 *
 * Priority:
 *   1. If token IS USDC → direct conversion (amountRaw / 10^6)
 *   2. If token IS WETH → getPairMidAtBlock(WETH, USDC, block) × amount
 *   3. token/USDC direct pair
 *   4. token/WETH × WETH/USDC (two-hop)
 *
 * Returns the USDC value or null if pricing fails.
 */
export async function getTokenUsdcValue(
  client: PublicClient,
  token: string,
  amountRaw: bigint,
  blockNumber: bigint,
  decimalsOf: (address: string) => Promise<number>,
): Promise<number | null> {
  const tokenLc = token.toLowerCase();

  // Direct USDC
  if (tokenLc === USDC) {
    return Number(amountRaw) / 1e6;
  }

  const tokenDec = await decimalsOf(tokenLc);
  const humanAmount = Number(amountRaw) / 10 ** tokenDec;

  // Direct WETH → USDC
  if (tokenLc === WETH) {
    const mid = await getPairMidAtBlock(client, WETH, USDC, blockNumber, decimalsOf);
    if (mid === null) return null;
    return humanAmount * mid.price;
  }

  // Try token/USDC direct
  const directMid = await getPairMidAtBlock(client, tokenLc, USDC, blockNumber, decimalsOf);
  if (directMid !== null && directMid.price > 0) {
    return humanAmount * directMid.price;
  }

  // Try token/WETH → WETH/USDC (two-hop)
  const tokenWethMid = await getPairMidAtBlock(client, tokenLc, WETH, blockNumber, decimalsOf);
  if (tokenWethMid !== null && tokenWethMid.price > 0) {
    const wethUsdcMid = await getPairMidAtBlock(client, WETH, USDC, blockNumber, decimalsOf);
    if (wethUsdcMid !== null && wethUsdcMid.price > 0) {
      return humanAmount * tokenWethMid.price * wethUsdcMid.price;
    }
  }

  return null;
}
