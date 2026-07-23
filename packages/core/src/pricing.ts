/**
 * pricing.ts — receipt pricing via the single Market Price apparatus.
 *
 * `priceReceipt` produces one pool-relative Market Price (output-per-input) at
 * block N-1 from `getMarketPriceForPair` (marketPrice.ts): liquidity pools set the
 * mid, an independent oracle-implied ratio corroborates the confidence tier
 * (full/estimated/none) but never moves the mid. A USD anchor (stable / WETH-ETH
 * benchmark) dollarizes the one ratio into a best-effort notional. NEVER THROWS —
 * any failure degrades to a complete `partial`/none result. The Branch-1 USDC/WETH
 * fast-path is retained pending the Phase-3 module collapse.
 */

import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { getBenchmarkMid, type BenchmarkResult } from './benchmarkPrice.js';
import {
  getDeepestPoolForPair,
  getDeepestPoolWithDepth,
  readSlot0,
  readLiquidity,
  readV2Reserves,
  type PoolKind,
} from './poolDiscovery.js';
import { mechanismForKind } from './poolFamilies.js';
import {
  makeRpcDecimalsCache,
  sqrtPriceX96ToPrice,
  v2MidFromReserves,
  getTokenUsdcValue,
  getEstimatedMidAtBlock,
  ESTIMATED_MID_MIN_LIQUIDITY,
  type PairMidResult,
} from './tokenPricing.js';
import {
  getMarketPriceForPair,
  type MarketPriceResult,
  type MarketPriceTier,
} from './marketPrice.js';
import { readTokenUsd } from './tokenOracle.js';

// ── Anchor token allowlist (Base) — the ONE definition lives in receiptPure. ──
import {
  USDC, USDBC, DAI, WETH, NATIVE,
  isStable, isWeth, isNative, anchorsToUsd,
} from './receiptPure.js';

/**
 * Known symbols — avoid an RPC round-trip for common tokens. This is only a
 * cache/override: any other token resolves via an on-chain `symbol()` read
 * (see `readSymbol`). The exception is `native` (ETH), which is a synthetic
 * endpoint with no contract to call `symbol()` on, so it MUST be listed here.
 */
const KNOWN_SYMBOLS: ReadonlyMap<string, string> = new Map([
  [USDC, 'USDC'],
  [USDBC, 'USDbC'],
  [DAI, 'DAI'],
  [WETH, 'WETH'],
  [NATIVE, 'ETH'],
]);

const isUsdcWethPair = (input: string, output: string): boolean => {
  const i = input.toLowerCase();
  const o = output.toLowerCase();
  return (i === USDC && o === WETH) || (i === WETH && o === USDC);
};

/** The WETH bridge is an independent estimator UNLESS a side is literal WETH — in
 *  which case the direct estimator already reads that same WETH pool and the bridge
 *  collapses to it. Native ETH is NOT suppressed: `defaultGetPairMid` returns null
 *  for the synthetic `'native'` endpoint (no direct pool), so the bridge is the only
 *  liquidity estimator for native pairs and must be kept. */
export function bridgedIsIndependent(inputToken: string, outputToken: string): boolean {
  return !isWeth(inputToken) && !isWeth(outputToken);
}

/** Oracle-implied output-per-input ratio from independent per-side USD refs, or
 *  null. A single ratio (one number) — never a per-side display price. */
export function impliedOracleRatio(usdIn: number | null, usdOut: number | null): number | null {
  if (usdIn == null || usdOut == null || !Number.isFinite(usdIn) || !Number.isFinite(usdOut) || usdOut <= 0) {
    return null;
  }
  return usdIn / usdOut;
}

// ── Result interface ─────────────────────────────────────────────────────────

export interface PricingResult {
  status: 'full' | 'estimated' | 'partial';
  /** Output-per-input mid at block N-1; null when partial. */
  marketMid: number | null;
  notionalUsd: number | null;
  inputSymbol: string;
  outputSymbol: string;
  inputDecimals: number;
  outputDecimals: number;
  // Benchmark oracle-validation passthrough (null for non-WETH/USDC pairs).
  chainlinkPrice: number | null;
  poolDivergenceBps: number | null;
  manipulationFlag: boolean;
  tier: MarketPriceTier;
  methodology: string;
  marketPriceFlags: string[];
  chainlinkDevBps: number | null;
  offchainPrice: number | null;
  offchainDevBps: number | null;
  chainlinkStalenessSecs: number | null;
}

// ── DI seam ──────────────────────────────────────────────────────────────────

export interface PricingDeps {
  /** WETH/USDC oracle-validated benchmark (samples at blockNumber-1 internally). */
  benchmark: (args: { rpcUrl: string; blockNumber: bigint }) => Promise<BenchmarkResult>;
  /** Deepest-pool mid: output(tokenOut)-per-input(tokenIn) at `blockNumber`. */
  getPairMid: (tokenIn: string, tokenOut: string, blockNumber: bigint) => Promise<PairMidResult | null>;
  /** Best-effort bridged mid (output-per-input) for illiquid pairs, or null. */
  getEstimatedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<PairMidResult | null>;
  /** The single Market Price apparatus: one corroborated mid + tier. */
  getMarketPrice: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<MarketPriceResult>;
  /** Best-effort USD value of `amountRaw` of `token` at `blockNumber`. */
  getUsdValue: (
    token: string,
    amountRaw: bigint,
    blockNumber: bigint,
    precomputedWethUsd?: number,
  ) => Promise<number | null>;
  readDecimals: (token: string) => Promise<number>;
  readSymbol: (token: string) => Promise<string>;
}

const ERC20_SYMBOL_ABI = parseAbi(['function symbol() view returns (string)']);

/**
 * Low-level readers `defaultGetPairMid` needs, decoupled from a live
 * `PublicClient` so the orientation/inversion math below is directly
 * testable with pure fakes (no RPC, no viem mocking required).
 */
/**
 * Uniswap V3 `sqrtPriceX96` bounds. A pool whose slot0 is pinned at (or within
 * one of) either bound has run to its last usable tick — it's empty / one-sided,
 * and its slot0 "price" is a garbage extreme, not a usable mid (see the CLAWNCH
 * case: a 0-liquidity USDC/pool at MAX_SQRT_RATIO produced a ~1e-27 mid).
 */
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export interface PoolMidReaders {
  /** Deepest initialized pool for the already address-sorted (token0, token1) pair. */
  getDeepestPool: (
    token0: string,
    token1: string,
    blockNumber: bigint,
  ) => Promise<{ address: string; kind: string } | null>;
  /** Raw `slot0` sqrtPriceX96 read for a given pool address. */
  readSlot0: (poolAddress: string, blockNumber: bigint) => Promise<bigint | null>;
  /** In-range `liquidity()` for a pool at a block; null on revert. Used to reject
   *  empty pools whose slot0 price is not a usable mid. */
  readLiquidity: (poolAddress: string, blockNumber: bigint) => Promise<bigint | null>;
  /** Reserves for a basic-AMM (Solidly/UniV2) pool; null on revert or empty. */
  readV2Reserves: (poolAddress: string, blockNumber: bigint) => Promise<[bigint, bigint] | null>;
  readDecimals: (address: string) => Promise<number>;
}

/**
 * Compute an arbitrary-pair mid from the deepest on-chain pool.
 *
 * `getDeepestPoolForPair` can return either a V3-style pool (mid via `slot0`)
 * or a basic-AMM pool (mid via `getReserves`); `mechanismForKind` picks the
 * branch. Both branches yield token1-per-token0 (Uniswap sort order, lower
 * address = token0); we invert when the caller's `tokenIn` is the higher
 * address so the result is always output-per-input.
 *
 * Exported (and parameterized over `PoolMidReaders` rather than a raw
 * `PublicClient`) so this — the highest-risk math in the module — can be
 * unit-tested directly with fake readers instead of only indirectly via a
 * stubbed `getPairMid`. See pricing.test.ts.
 */
export async function defaultGetPairMid(
  readers: PoolMidReaders,
  tokenIn: string,
  tokenOut: string,
  blockNumber: bigint,
): Promise<PairMidResult | null> {
  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const inverted = inLc > outLc; // tokenIn is token1 → need 1/raw
  const token0 = inverted ? outLc : inLc;
  const token1 = inverted ? inLc : outLc;

  const pool = await readers.getDeepestPool(token0, token1, blockNumber);
  if (!pool) return null;

  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  let rawPrice: number; // token1 per token0

  if (mechanismForKind(pool.kind as PoolKind) === 'v2-reserves') {
    const reserves = await readers.readV2Reserves(pool.address, blockNumber);
    if (reserves === null || reserves[0] === 0n || reserves[1] === 0n) return null;
    rawPrice = v2MidFromReserves(reserves[0], reserves[1], dec0, dec1);
  } else {
    const sqrtPriceX96 = await readers.readSlot0(pool.address, blockNumber);
    if (sqrtPriceX96 === null) return null;

    // Reject an empty / one-sided pool: its slot0 price is a garbage extreme, not
    // a usable mid. Two signals — a price pinned at a tick boundary, or liquidity
    // below the floor. Returning null here lets priceReceipt fall through to the
    // bridged `estimated` mid instead of quoting a bogus `full` mid.
    if (sqrtPriceX96 <= MIN_SQRT_RATIO + 1n || sqrtPriceX96 >= MAX_SQRT_RATIO - 1n) return null;
    const liquidity = await readers.readLiquidity(pool.address, blockNumber);
    if (liquidity === null || liquidity < ESTIMATED_MID_MIN_LIQUIDITY) return null;
    rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
  }

  const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
  if (!(price > 0)) return null;
  return { price, poolAddress: pool.address, poolKind: pool.kind };
}

/**
 * Build the live RPC-backed default dependency set (mirrors
 * `createDefaultMidReader`). Constructing this is side-effect-free until the
 * readers are actually invoked, so it's cheap to create even when a caller
 * intends to override some deps in a test.
 */
export function createDefaultPricingDeps(rpcUrl: string): PricingDeps {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as PublicClient;
  const decCache = makeRpcDecimalsCache(client);

  const poolReaders: PoolMidReaders = {
    getDeepestPool: (token0, token1, blockNumber) => getDeepestPoolForPair(client, token0, token1, blockNumber),
    readSlot0: (poolAddress, blockNumber) => readSlot0(client, poolAddress as `0x${string}`, blockNumber),
    readLiquidity: (poolAddress, blockNumber) => readLiquidity(client, poolAddress as `0x${string}`, blockNumber),
    readV2Reserves: (poolAddress, blockNumber) => readV2Reserves(client, poolAddress as `0x${string}`, blockNumber),
    readDecimals: decCache,
  };

  const symCache = new Map<string, string>();
  for (const [addr, sym] of KNOWN_SYMBOLS) symCache.set(addr, sym);
  const readSymbol = async (token: string): Promise<string> => {
    const key = token.toLowerCase();
    const hit = symCache.get(key);
    if (hit !== undefined) return hit;
    const sym = await client.readContract({
      address: key as `0x${string}`,
      abi: ERC20_SYMBOL_ABI,
      functionName: 'symbol',
    });
    symCache.set(key, sym);
    return sym;
  };

  return {
    benchmark: getBenchmarkMid,
    getPairMid: (tokenIn, tokenOut, blockNumber) => defaultGetPairMid(poolReaders, tokenIn, tokenOut, blockNumber),
    getEstimatedMid: (inputToken, outputToken, blockNumber) =>
      getEstimatedMidAtBlock(
        {
          getDeepestPoolWithDepth: async (a, b, block) => {
            const best = await getDeepestPoolWithDepth(client, a, b, block);
            return best ? { address: best.pool.address, depth: best.depth, kind: best.pool.kind } : null;
          },
          readSlot0: (pool, block) => readSlot0(client, pool as `0x${string}`, block),
          readV2Reserves: (pool, block) => readV2Reserves(client, pool as `0x${string}`, block),
          readDecimals: decCache,
        },
        inputToken,
        outputToken,
        blockNumber,
        ESTIMATED_MID_MIN_LIQUIDITY,
      ),
    getMarketPrice: (inputToken, outputToken, blockNumber) =>
      getMarketPriceForPair(
        {
          getDirectMid: async (i, o, blk) => (await defaultGetPairMid(poolReaders, i, o, blk))?.price ?? null,
          getBridgedMid: async (i, o, blk) => {
            if (!bridgedIsIndependent(i, o)) return null; // duplicates direct for WETH pairs
            return (await getEstimatedMidAtBlock(
              {
                getDeepestPoolWithDepth: async (a, b, b2) => {
                  const best = await getDeepestPoolWithDepth(client, a, b, b2);
                  return best ? { address: best.pool.address, depth: best.depth, kind: best.pool.kind } : null;
                },
                readSlot0: (pool, b2) => readSlot0(client, pool as `0x${string}`, b2),
                readV2Reserves: (pool, b2) => readV2Reserves(client, pool as `0x${string}`, b2),
                readDecimals: decCache,
              }, i, o, blk, ESTIMATED_MID_MIN_LIQUIDITY))?.price ?? null;
          },
          getOracleImpliedMid: async (i, o, blk) => {
            // Independent per-side USD: stable=$1, WETH/native via the WETH/USD
            // backbone, mapped feeds (e.g. WBTC->BTC/USD) via readTokenUsd. Fires
            // only when BOTH sides resolve. readTokenUsd/benchmark sample at
            // blockNumber-1 internally, so pass blk+1n (blk is already N-1).
            const usdIndep = async (token: string): Promise<number | null> => {
              const t = token.toLowerCase();
              if (isStable(t)) return 1;
              if (isWeth(t) || isNative(t)) {
                try {
                  const b = await getBenchmarkMid({ rpcUrl, blockNumber: blk + 1n });
                  return b.marketMid > 0 ? b.marketMid : null;
                } catch { return null; }
              }
              return readTokenUsd(t, blk + 1n, rpcUrl, client); // reuse the closure's client
            };
            const [ui, uo] = await Promise.all([usdIndep(i), usdIndep(o)]);
            return impliedOracleRatio(ui, uo);
          },
        },
        inputToken,
        outputToken,
        blockNumber,
      ),
    getUsdValue: (token, amountRaw, blockNumber, precomputedWethUsd) =>
      getTokenUsdcValue(client, token, amountRaw, blockNumber, decCache, precomputedWethUsd),
    readDecimals: decCache,
    readSymbol,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Best-effort symbol guess used when even the metadata reads fail (never throw). */
function fallbackSymbolFor(token: string): string {
  return KNOWN_SYMBOLS.get(token.toLowerCase()) ?? '???';
}
/** Human-readable methodology string derived from a Market Price apparatus result. */
function methodologyFor(mp: MarketPriceResult): string {
  if (mp.tier === 'none') return 'No reliable market price available.';
  if (mp.tier === 'estimated') {
    if (mp.flags.includes('ORACLE_DISAGREE')) return 'Estimated: oracle disagreed with the pool mid; showing the pool mid.';
    if (mp.flags.includes('LIQUIDITY_DISAGREE')) return 'Estimated: pools disagreed; showing the median pool mid.';
    return 'Estimated: single uncorroborated pool mid at block N-1.';
  }
  return `Corroborated market price (${mp.corroboratedBy.join(' + ')}) at block N-1.`;
}
/** Best-effort decimals guess used when even the metadata reads fail (never throw). */
function fallbackDecimalsFor(token: string): number {
  if (isWeth(token)) return 18;
  if (isStable(token)) return 6;
  return 18; // conservative default; only used for display when metadata is unavailable
}
async function safeSymbol(read: (t: string) => Promise<string>, token: string): Promise<string> {
  try {
    return await read(token);
  } catch {
    return fallbackSymbolFor(token);
  }
}
async function safeDecimals(read: (t: string) => Promise<number>, token: string): Promise<number> {
  try {
    return await read(token);
  } catch {
    return fallbackDecimalsFor(token);
  }
}

export async function priceReceipt(
  args: {
    rpcUrl: string;
    blockNumber: bigint;
    chainId: number;
    inputToken: string;
    outputToken: string;
    inputAmountRaw: bigint;
    outputAmountRaw: bigint;
  },
  depsOverride?: Partial<PricingDeps>,
): Promise<PricingResult> {
  const { inputToken, outputToken, blockNumber } = args;

  // Reference mid samples at the block BEFORE the trade settled (spec §4).
  const refBlock = blockNumber > 0n ? blockNumber - 1n : blockNumber;

  // Best-effort metadata defaults, used verbatim by `partial()` if we fail
  // before the real reads (or even deps construction) complete below —
  // reassigned to the real values as soon as the Promise.all resolves.
  let inputSymbol = fallbackSymbolFor(inputToken);
  let outputSymbol = fallbackSymbolFor(outputToken);
  let inputDecimals = fallbackDecimalsFor(inputToken);
  let outputDecimals = fallbackDecimalsFor(outputToken);

  const partial = (notionalUsd: number | null = null): PricingResult => ({
    status: 'partial',
    marketMid: null,
    notionalUsd,
    inputSymbol,
    outputSymbol,
    inputDecimals,
    outputDecimals,
    chainlinkPrice: null,
    poolDivergenceBps: null,
    manipulationFlag: false,
    tier: 'none',
    methodology: 'No reliable market price available.',
    marketPriceFlags: [],
    chainlinkDevBps: null,
    offchainPrice: null,
    offchainDevBps: null,
    chainlinkStalenessSecs: null,
  });

  try {
    // Deps construction happens INSIDE the try: NEVER-THROW is a hard contract,
    // so a failure here (e.g. an unparsable rpcUrl) must also degrade to
    // `partial`, not throw past this function.
    const deps: PricingDeps = { ...createDefaultPricingDeps(args.rpcUrl), ...depsOverride };

    // Metadata is best-effort and shared by every return path.
    [inputSymbol, outputSymbol, inputDecimals, outputDecimals] = await Promise.all([
      safeSymbol(deps.readSymbol, inputToken),
      safeSymbol(deps.readSymbol, outputToken),
      safeDecimals(deps.readDecimals, inputToken),
      safeDecimals(deps.readDecimals, outputToken),
    ]);

    // ── Branch 1: USDC/WETH fast-path — full oracle-validated benchmark ──
    if (isUsdcWethPair(inputToken, outputToken)) {
      const bench = await deps.benchmark({ rpcUrl: args.rpcUrl, blockNumber });
      // bench.marketMid is USDC-per-WETH. We want output-per-input.
      const wethUsd = bench.marketMid;
      const marketMid = isWeth(inputToken)
        ? wethUsd // WETH in, USDC out
        : wethUsd > 0
          ? 1 / wethUsd // USDC in, WETH out
          : null;
      const notionalUsd = await bestEffortNotional(deps, args, refBlock, wethUsd);
      return {
        status: 'full',
        marketMid,
        notionalUsd,
        inputSymbol,
        outputSymbol,
        inputDecimals,
        outputDecimals,
        chainlinkPrice: bench.chainlinkPrice,
        poolDivergenceBps: bench.poolDivergenceBps,
        manipulationFlag: bench.manipulationSuspect,
        tier: 'full',
        methodology: 'Corroborated WETH/USD benchmark (median pools + oracle) at block N-1.',
        marketPriceFlags: bench.flags,
        chainlinkDevBps: bench.chainlinkDevBps,
        offchainPrice: bench.offchainPrice,
        offchainDevBps: bench.offchainDevBps,
        chainlinkStalenessSecs: bench.chainlinkStalenessSecs,
      };
    }

    // ── Generic pair via the single Market Price apparatus ──
    const mp = await deps.getMarketPrice(inputToken, outputToken, refBlock);
    const anchored = anchorsToUsd(inputToken) || anchorsToUsd(outputToken);
    const methodology = methodologyFor(mp);

    if (mp.marketMid != null && mp.marketMid > 0) {
      const notionalUsd = await bestEffortNotional(deps, args, refBlock);
      const status: PricingResult['status'] = mp.tier === 'full' && anchored ? 'full' : 'estimated';
      return {
        status,
        marketMid: mp.marketMid,
        notionalUsd,
        inputSymbol, outputSymbol, inputDecimals, outputDecimals,
        chainlinkPrice: null, poolDivergenceBps: null, manipulationFlag: false,
        chainlinkDevBps: null, offchainPrice: null, offchainDevBps: null, chainlinkStalenessSecs: null,
        tier: mp.tier, methodology, marketPriceFlags: mp.flags,
      };
    }

    const notionalUsd = await bestEffortNotional(deps, args, refBlock);
    return { ...partial(notionalUsd), tier: 'none', methodology, marketPriceFlags: mp.flags };
  } catch {
    // Any failure (transient RPC, decode, etc.) degrades to partial — never throw.
    return partial(null);
  }
}

/**
 * Best-effort USD notional.
 *
 * Value the USD-ANCHORED side first, not blindly the input side. A volatile,
 * illiquid token (e.g. WARP) priced directly against USDC can resolve to a
 * dead/stale reference pool and mis-value the trade by multiples — for a
 * WARP→ETH swap the input-side WARP/USDC pool had zero in-range liquidity yet a
 * stale mid, inflating notional ~7×. The anchored leg (stablecoin or ETH/WETH,
 * priced via the deep WETH/USDC reference) is the trustworthy USD peg, so prefer
 * it. When exactly one side anchors, value THAT side first; otherwise keep the
 * historical input-first order. Any error swallows to null (the caller decides
 * full vs partial independently).
 */
async function bestEffortNotional(
  deps: PricingDeps,
  args: { inputToken: string; outputToken: string; inputAmountRaw: bigint; outputAmountRaw: bigint },
  refBlock: bigint,
  precomputedWethUsd?: number,
): Promise<number | null> {
  const inputSide: [string, bigint] = [args.inputToken, args.inputAmountRaw];
  const outputSide: [string, bigint] = [args.outputToken, args.outputAmountRaw];
  // Prefer the anchored side only when it's UNambiguously the output — i.e. the
  // output anchors and the input does not. Ties/both-anchored keep input-first.
  const preferOutput = anchorsToUsd(args.outputToken) && !anchorsToUsd(args.inputToken);
  const order = preferOutput ? [outputSide, inputSide] : [inputSide, outputSide];

  for (const [token, amountRaw] of order) {
    try {
      const value = await deps.getUsdValue(token, amountRaw, refBlock, precomputedWethUsd);
      if (value != null && value > 0) return value;
    } catch {
      // fall through to the other side
    }
  }
  return null;
}
