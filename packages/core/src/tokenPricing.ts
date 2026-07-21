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
} from './poolDiscovery.js';
import type { Leg } from './routeGraph.js';
import { sqrtPriceX96ToPrice, v2MidFromReserves } from './priceMath.js';

// ── Constants ────────────────────────────────────────────────────────────────

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
/** Synthetic endpoint for native ETH (mirrors `NATIVE` in pricing.ts / endpoints.ts). */
const NATIVE = 'native';

/**
 * Liquidity floor for the best-effort ("estimated") market mid. The deepest
 * `token/WETH` pool backing a volatile side must clear this in-range
 * `liquidity()` depth, else we refuse to quote a mid (tier stays `partial`).
 * A depth of 0 (dead pool) is always rejected. Conservative default — tune up
 * as we learn what depth is "trustworthy enough" for a given token.
 */
export const ESTIMATED_MID_MIN_LIQUIDITY = 1n;

/** Known decimals — avoid RPC for common tokens. */
const KNOWN_DECIMALS: ReadonlyMap<string, number> = new Map([
  [USDC, 6],
  [WETH, 18],
]);

// ── Pure math ────────────────────────────────────────────────────────────────
// `sqrtPriceX96ToPrice` and `v2MidFromReserves` now live in the priceMath leaf
// (shared with referencePrice); re-exported here for existing importers.
export { sqrtPriceX96ToPrice, v2MidFromReserves };

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
  precomputedWethUsd?: number,
): Promise<PairMidResult | null> {
  const { token0, token1, inverted } = sortTokens(tokenA, tokenB);

  // Caller-supplied WETH/USD (e.g. the validated benchmark mid) wins over a pool read.
  if (precomputedWethUsd != null) {
    const aIsWeth = tokenA.toLowerCase() === WETH && tokenB.toLowerCase() === USDC;
    const bIsWeth = tokenB.toLowerCase() === WETH && tokenA.toLowerCase() === USDC;
    if (aIsWeth) return { price: precomputedWethUsd, poolAddress: 'precomputed', poolKind: 'precomputed' };
    if (bIsWeth) return { price: precomputedWethUsd > 0 ? 1 / precomputedWethUsd : 0, poolAddress: 'precomputed', poolKind: 'precomputed' };
  }

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

export interface EstimatedMidReaders {
  getDeepestPoolWithDepth: (a: string, b: string, block: bigint) => Promise<{ address: string; depth: bigint } | null>;
  readSlot0: (pool: string, block: bigint) => Promise<bigint | null>;
  readDecimals: (addr: string) => Promise<number>;
}

/** WETH-per-token (or USDC-per-WETH for the anchor) via the deepest pool, no floor. */
async function midViaDeepest(
  readers: EstimatedMidReaders,
  tokenA: string,
  tokenB: string,
  block: bigint,
): Promise<{ price: number; depth: bigint } | null> {
  const disc = await readers.getDeepestPoolWithDepth(tokenA, tokenB, block);
  if (!disc) return null;
  const sqrt = await readers.readSlot0(disc.address, block);
  if (sqrt === null || sqrt <= 0n) return null;
  const inverted = tokenA.toLowerCase() > tokenB.toLowerCase();
  const token0 = inverted ? tokenB : tokenA;
  const token1 = inverted ? tokenA : tokenB;
  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  const raw = sqrtPriceX96ToPrice(sqrt, dec0, dec1); // token1 per token0
  const price = inverted ? (raw > 0 ? 1 / raw : 0) : raw; // tokenB per tokenA
  return { price, depth: disc.depth };
}

/** USD value of one unit of `token`, floor-gated for volatile tokens. */
async function usdRef(
  readers: EstimatedMidReaders,
  token: string,
  block: bigint,
  wethUsd: number,
  minLiquidity: bigint,
): Promise<number | null> {
  const t = token.toLowerCase();
  if (t === USDC) return 1;
  if (t === NATIVE || t === WETH) return wethUsd;
  // Volatile: price via the floor-gated deepest token/WETH pool. NEVER the
  // direct token/USDC pool (dead-pool trap).
  const m = await midViaDeepest(readers, t, WETH, block); // WETH per token
  if (m === null || m.depth < minLiquidity || m.price <= 0) return null;
  return m.price * wethUsd;
}

/**
 * Best-effort ("estimated") output-per-input market mid for a pair whose direct
 * pool is illiquid/absent. Prices each side independently through its deepest
 * `token/WETH` pool (Approach A) and returns the ratio. Returns null when either
 * side can't be priced above the liquidity floor. NEVER the direct token/USDC
 * pool. Reference block is the caller's (already N-1).
 */
export async function getEstimatedMidAtBlock(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
): Promise<PairMidResult | null> {
  const anchor = await midViaDeepest(readers, WETH, USDC, blockNumber); // USDC per WETH
  if (anchor === null || anchor.price <= 0 || anchor.depth < minLiquidity) return null;
  const wethUsd = anchor.price;
  const usdIn = await usdRef(readers, inputToken, blockNumber, wethUsd, minLiquidity);
  const usdOut = await usdRef(readers, outputToken, blockNumber, wethUsd, minLiquidity);
  if (usdIn === null || usdOut === null || usdOut <= 0) return null;
  return { price: usdIn / usdOut, poolAddress: 'bridged', poolKind: 'estimated' };
}

/**
 * Get the USDC value of a token amount at a given block.
 *
 * Priority:
 *   1. If token IS USDC → direct conversion (amountRaw / 10^6)
 *   2. If token IS native ETH → 1:1 with WETH, via WETH/USDC × amount
 *   3. If token IS WETH → getPairMidAtBlock(WETH, USDC, block) × amount
 *   4. token/USDC direct pair
 *   5. token/WETH × WETH/USDC (two-hop)
 *
 * Returns the USDC value or null if pricing fails.
 */
export async function getTokenUsdcValue(
  client: PublicClient,
  token: string,
  amountRaw: bigint,
  blockNumber: bigint,
  decimalsOf: (address: string) => Promise<number>,
  precomputedWethUsd?: number,
): Promise<number | null> {
  const tokenLc = token.toLowerCase();

  // Direct USDC
  if (tokenLc === USDC) {
    return Number(amountRaw) / 1e6;
  }

  // Native ETH: a synthetic endpoint with no contract to read `decimals()` from
  // and no pool of its own. It is 1:1 with WETH (18 decimals), so value it via
  // the WETH/USDC reference. This MUST run before the `decimalsOf` read below,
  // which would revert on the "native" pseudo-address.
  if (tokenLc === NATIVE) {
    const humanEth = Number(amountRaw) / 1e18;
    if (precomputedWethUsd != null) return humanEth * precomputedWethUsd;
    const mid = await getPairMidAtBlock(client, WETH, USDC, blockNumber, decimalsOf);
    if (mid === null) return null;
    return humanEth * mid.price;
  }

  const tokenDec = await decimalsOf(tokenLc);
  const humanAmount = Number(amountRaw) / 10 ** tokenDec;

  // Direct WETH → USDC
  if (tokenLc === WETH) {
    if (precomputedWethUsd != null) return humanAmount * precomputedWethUsd;
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

