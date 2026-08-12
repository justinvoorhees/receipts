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
  type PoolKind,
} from './poolDiscovery.js';
import { mechanismForKind, pickReferenceToken } from './poolFamilies.js';
import { sqrtPriceX96ToPrice, v2MidFromReserves } from './priceMath.js';

// ── Constants ────────────────────────────────────────────────────────────────

import { USDC, WETH, isStable, isWeth, isNative } from './receiptPure.js';
/** Synthetic endpoint for native ETH (mirrors `NATIVE` in pricing.ts / endpoints.ts). */
const NATIVE = 'native';

/**
 * V3 virtual-liquidity (`L`) sanity floor: "this pool is not empty". Compared
 * against `readLiquidity()`, whose units are L — NOT tokens.
 *
 * ⚠️ This is NOT a depth threshold and must never be raised to act as one. The
 * old single constant was compared against BOTH an `L` value (pricing.ts) and a
 * `balanceOf` token amount (usdRef / the anchor here), so raising it applied a
 * token-amount threshold to an L value. The real depth floor is
 * `MIN_REFERENCE_DEPTH_USD` below — a separate concept in different units.
 */
export const MIN_POOL_LIQUIDITY_L = 1n;

/**
 * Back-compat alias for the pre-split name.
 * @deprecated prefer `MIN_POOL_LIQUIDITY_L` (an L sanity check) or
 * `MIN_REFERENCE_DEPTH_USD` (the actual depth floor) — they are not the same.
 */
export const ESTIMATED_MID_MIN_LIQUIDITY = MIN_POOL_LIQUIDITY_L;

/**
 * Absolute USD floor on the DEPTH of the ranked reference pool.
 *
 * Trade-independent on purpose: two receipts on the same pair in the same block
 * must get the same market price, which a notional-scaled floor would break (see
 * the single-ruler spec). Calibrated against the frozen 62-row corpus on
 * 2026-08-12 — every confirmed dust-ruler case measured <= $0.22, and the
 * next-thinnest corpus pool is $177.63, so this sits in a 4,400x gap.
 */
export const MIN_REFERENCE_DEPTH_USD = 100;

/**
 * USD value of a `balanceOf(refToken)` depth, or `null` when `refToken` is not
 * free-priceable. A null result means the check was NOT PERFORMED — callers must
 * record that (DEPTH_UNVERIFIED) rather than treat it as having passed.
 *
 * ⚠️ `decimals` is a parameter, not an assumption: STABLECOINS holds DAI at 18
 * decimals alongside USDC/USDbC at 6. Hardcoding 1e6 for "a stable" would
 * overstate a DAI-referenced pool by 1e12 and silently defeat the floor.
 */
export function depthUsd(
  refToken: string,
  rawDepth: bigint,
  wethUsd: number,
  decimals: number,
): number | null {
  const t = refToken.toLowerCase();
  if (isStable(t)) return Number(rawDepth) / 10 ** decimals;
  if (isWeth(t) || isNative(t)) {
    if (!Number.isFinite(wethUsd) || wethUsd <= 0) return null;
    return (Number(rawDepth) / 10 ** decimals) * wethUsd;
  }
  return null;
}

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
  getDeepestPoolWithDepth: (a: string, b: string, block: bigint) => Promise<{ address: string; depth: bigint; kind: string } | null>;
  readSlot0: (pool: string, block: bigint) => Promise<bigint | null>;
  readV2Reserves: (pool: string, block: bigint) => Promise<[bigint, bigint] | null>;
  readDecimals: (addr: string) => Promise<number>;
}

/**
 * WETH-per-token (or USDC-per-WETH for the anchor) via the deepest pool, no
 * floor. `getDeepestPoolWithDepth` can return either a V3-style pool (mid via
 * `slot0`) or a basic-AMM pool (mid via `getReserves`); `mechanismForKind`
 * picks the branch, mirroring `defaultGetPairMid` in pricing.ts.
 *
 * Exported so this branch is directly unit-testable with fake readers.
 */
export async function midViaDeepest(
  readers: EstimatedMidReaders,
  tokenA: string,
  tokenB: string,
  block: bigint,
): Promise<{ price: number; depth: bigint } | null> {
  const disc = await readers.getDeepestPoolWithDepth(tokenA, tokenB, block);
  if (!disc) return null;
  const inverted = tokenA.toLowerCase() > tokenB.toLowerCase();
  const token0 = inverted ? tokenB : tokenA;
  const token1 = inverted ? tokenA : tokenB;
  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  let raw: number; // token1 per token0
  if (mechanismForKind(disc.kind as PoolKind) === 'v2-reserves') {
    const r = await readers.readV2Reserves(disc.address, block);
    if (r === null || r[0] === 0n || r[1] === 0n) return null;
    raw = v2MidFromReserves(r[0], r[1], dec0, dec1);
  } else {
    const sqrt = await readers.readSlot0(disc.address, block);
    if (sqrt === null || sqrt <= 0n) return null;
    raw = sqrtPriceX96ToPrice(sqrt, dec0, dec1);
  }
  const price = inverted ? (raw > 0 ? 1 / raw : 0) : raw; // tokenB per tokenA
  if (!(price > 0)) return null;
  return { price, depth: disc.depth };
}

/** What one side's valuation observed, so the caller can explain a refusal. */
interface SideOutcome {
  /** USD per one unit of the token; null when it could not be priced. */
  price: number | null;
  /** Depth of the pool used, in USD; null when it could not be valued. */
  usd: number | null;
  pool: string | null;
  /** True when a pool existed and was rejected for being too thin. */
  rejected: boolean;
  /** True when the depth check could not be performed (volatile refToken). */
  unverified: boolean;
}

const ANCHORED_SIDE: SideOutcome = { price: null, usd: null, pool: null, rejected: false, unverified: false };

/**
 * USD value of one unit of `token`, gated on both the L sanity floor and the
 * USD depth floor. Returns its evidence rather than a bare number: a rejection
 * is indistinguishable from an absent pool once it reaches `computeMarketPrice`,
 * so the reason has to travel out of here.
 */
async function usdRefGated(
  readers: EstimatedMidReaders,
  token: string,
  block: bigint,
  wethUsd: number,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<SideOutcome> {
  const t = token.toLowerCase();
  // Anchored sides need no pool at all, so there is no depth to gate.
  if (t === USDC) return { ...ANCHORED_SIDE, price: 1 };
  if (t === NATIVE || t === WETH) return { ...ANCHORED_SIDE, price: wethUsd };

  // Volatile: price via the deepest token/WETH pool. NEVER the direct
  // token/USDC pool (dead-pool trap).
  const disc = await readers.getDeepestPoolWithDepth(t, WETH, block);
  if (disc === null) return ANCHORED_SIDE;

  const ref = pickReferenceToken(t, WETH);
  const usd = depthUsd(ref, disc.depth, wethUsd, await readers.readDecimals(ref));

  // Gate the ranked WINNER. A depth we cannot value is recorded as unverified
  // and allowed through — the check is reported as not performed, never as passed.
  if (usd !== null && usd < minDepthUsd) {
    return { price: null, usd, pool: disc.address, rejected: true, unverified: false };
  }

  const m = await midViaDeepest(readers, t, WETH, block); // WETH per token
  const unverified = usd === null;
  if (m === null || m.depth < minLiquidity || m.price <= 0) {
    return { price: null, usd, pool: disc.address, rejected: false, unverified };
  }
  return { price: m.price * wethUsd, usd, pool: disc.address, rejected: false, unverified };
}

/** The gated WETH/USDC anchor, plus the evidence behind a refusal. */
interface AnchorOutcome {
  wethUsd: number | null;
  depthUsd: number | null;
  poolAddress: string | null;
  rejected: boolean;
}

/**
 * USDC-per-WETH via the deepest WETH/USDC pool, with the depth floor applied.
 *
 * Not circular: the anchor's own reference token is USDC, a stable, so its depth
 * is valued without needing `wethUsd`. Shared by the bridged estimator and the
 * notional path so both gate the anchor by the same rule — if they diverged, the
 * Market Price and Size rows could disagree about the same pool.
 */
async function resolveWethUsdGated(
  readers: EstimatedMidReaders,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<AnchorOutcome> {
  const none: AnchorOutcome = { wethUsd: null, depthUsd: null, poolAddress: null, rejected: false };
  const pool = await readers.getDeepestPoolWithDepth(WETH, USDC, blockNumber);
  if (pool === null) return none;
  const ref = pickReferenceToken(WETH, USDC); // USDC — a stable, so no wethUsd needed
  const usd = depthUsd(ref, pool.depth, 0, await readers.readDecimals(ref));
  if (usd !== null && usd < minDepthUsd) {
    return { wethUsd: null, depthUsd: usd, poolAddress: pool.address, rejected: true };
  }
  const anchor = await midViaDeepest(readers, WETH, USDC, blockNumber); // USDC per WETH
  if (anchor === null || anchor.price <= 0 || anchor.depth < minLiquidity) return none;
  return { wethUsd: anchor.price, depthUsd: usd, poolAddress: pool.address, rejected: false };
}

/** The bridged estimator plus the evidence behind a refusal. */
export interface EstimatedMidOutcome {
  mid: PairMidResult | null;
  /** Depth of the binding (thinnest) reference pool in USD, or null. */
  depthUsd: number | null;
  /** The pool that depth belongs to. */
  poolAddress: string | null;
  /** A pool existed and was rejected for being below the USD floor. */
  rejected: boolean;
  /** Depth could not be valued, so the floor was not applied. */
  unverified: boolean;
}

/**
 * Best-effort ("estimated") output-per-input market mid for a pair whose direct
 * pool is illiquid/absent, plus why it refused when it did.
 *
 * Prices each side independently through its deepest `token/WETH` pool and
 * returns the ratio. The WETH/USDC anchor is gated too — not circularly, since
 * its reference token is USDC and so its depth is valued without needing
 * `wethUsd`. Reference block is the caller's (already N-1).
 */
export async function getEstimatedMidOutcome(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<EstimatedMidOutcome> {
  const none: EstimatedMidOutcome = {
    mid: null, depthUsd: null, poolAddress: null, rejected: false, unverified: false,
  };

  const anchor = await resolveWethUsdGated(readers, blockNumber, minLiquidity, minDepthUsd);
  if (anchor.rejected) {
    return { ...none, rejected: true, depthUsd: anchor.depthUsd, poolAddress: anchor.poolAddress };
  }
  if (anchor.wethUsd === null) return none;
  const wethUsd = anchor.wethUsd;

  const [a, b] = await Promise.all([
    usdRefGated(readers, inputToken, blockNumber, wethUsd, minLiquidity, minDepthUsd),
    usdRefGated(readers, outputToken, blockNumber, wethUsd, minLiquidity, minDepthUsd),
  ]);

  // Report the THINNEST valued side: it is the binding constraint, and the pool
  // the methodology sentence has to name.
  const valued = [a, b].filter((s) => s.usd !== null);
  const thinnest = valued.length
    ? valued.reduce((lo, s) => ((s.usd as number) < (lo.usd as number) ? s : lo))
    : null;

  const base = {
    depthUsd: thinnest?.usd ?? null,
    poolAddress: thinnest?.pool ?? null,
    rejected: a.rejected || b.rejected,
    unverified: a.unverified || b.unverified,
  };

  if (a.price === null || b.price === null || b.price <= 0) return { ...base, mid: null };
  return { ...base, mid: { price: a.price / b.price, poolAddress: 'bridged', poolKind: 'estimated' } };
}

/**
 * Back-compat wrapper: the bridged mid alone, with the depth floor applied.
 * Callers that need to know WHY it refused should use `getEstimatedMidOutcome`.
 */
export async function getEstimatedMidAtBlock(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
): Promise<PairMidResult | null> {
  const out = await getEstimatedMidOutcome(
    readers, inputToken, outputToken, blockNumber, minLiquidity, MIN_REFERENCE_DEPTH_USD,
  );
  return out.mid;
}

/** A gated USD valuation, with the evidence behind a refusal. */
export interface GatedUsdValue {
  /** USD value of the amount, or null when no trustworthy pool priced it. */
  usd: number | null;
  /** A pool existed and was rejected for being below the USD depth floor. */
  rejected: boolean;
  /** Depth could not be valued, so the floor was not applied. */
  unverified: boolean;
}

/**
 * USD value of `amountRaw` of `token`, on the SAME ranked-and-floored apparatus
 * the Market Price ruler uses.
 *
 * The predecessor (`getTokenUsdcValue`) resolved mids through first-match
 * `discoverPool` and preferred the direct token/USDC pool — the dead-pool trap
 * that inflated a WARP->ETH notional ~7x. `usdRefGated` ranks by depth, prices
 * only through token/WETH, and refuses a winner under `minDepthUsd`.
 *
 * A refusal returns `usd: null`, which lets `bestEffortNotional` fall through to
 * the other side. That fall-through is what keeps an anchored side's notional on
 * receipts whose ruler was floored — the number there is independently derived
 * and correct, and hiding it would discard a measurement we trust.
 */
export async function getTokenUsdcValueGated(
  readers: EstimatedMidReaders,
  token: string,
  amountRaw: bigint,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
  precomputedWethUsd?: number,
): Promise<GatedUsdValue> {
  const t = token.toLowerCase();

  // USDC needs neither a pool nor the anchor — short-circuit before any RPC.
  if (t === USDC) {
    return { usd: Number(amountRaw) / 1e6, rejected: false, unverified: false };
  }

  let wethUsd = precomputedWethUsd;
  if (wethUsd == null) {
    const anchor = await resolveWethUsdGated(readers, blockNumber, minLiquidity, minDepthUsd);
    if (anchor.wethUsd === null) {
      return { usd: null, rejected: anchor.rejected, unverified: false };
    }
    wethUsd = anchor.wethUsd;
  }

  const side = await usdRefGated(readers, t, blockNumber, wethUsd, minLiquidity, minDepthUsd);
  if (side.price === null) {
    return { usd: null, rejected: side.rejected, unverified: side.unverified };
  }

  // native is a synthetic endpoint with no contract to read decimals() from; it
  // is 1:1 with WETH (18). This MUST precede the readDecimals call, which throws.
  const dec = t === NATIVE ? 18 : await readers.readDecimals(t);
  return {
    usd: (Number(amountRaw) / 10 ** dec) * side.price,
    rejected: false,
    unverified: side.unverified,
  };
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

