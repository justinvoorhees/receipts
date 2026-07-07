/**
 * pricing.ts — Generic USD anchor + reference mid with graceful degradation.
 *
 * The receipts tool analyzes ANY token pair. Price Impact and Slippage need a
 * reference mid for the traded pair at block N-1, plus a USD valuation for the
 * receipt. Today's benchmark machinery is WETH/USDC-specific; this module
 * generalizes it under a strict best-effort policy:
 *
 *   1. USDC/WETH (either direction) → delegate to `getBenchmarkMid` (the fully
 *      oracle-validated fast-path) → `status:'full'`.
 *   2. Else → find the deepest on-chain pool for (input, output) at N-1. If a
 *      mid exists AND at least one side anchors to USD (stablecoin allowlist, or
 *      WETH priced via WETH/USD) → `status:'full'` with a best-effort mid +
 *      notionalUsd. Per-pair oracle-validation fields are null (we have no
 *      per-pair oracle) — that's expected.
 *   3. Otherwise → `status:'partial'` (`marketMid=null`, `notionalUsd` best-
 *      effort-or-null). Downstream this means LP + Agg benchmarks only.
 *   4. NEVER THROWS. Any error (e.g. a transient RPC failure) degrades to a
 *      `status:'partial'` result — an honest partial beats bad pricing.
 *
 * Testability: `priceReceipt` takes an optional `PricingDeps` bag of injectable
 * readers that DEFAULT to the real RPC-backed implementations (mirroring
 * `createDefaultMidReader` in decomposeRoute.ts). Unit tests inject pure fakes,
 * so no live RPC is required.
 */

import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { getBenchmarkMid, type BenchmarkResult } from './benchmarkPrice.js';
import { getDeepestPoolForPair, readSlot0 } from './poolDiscovery.js';
import {
  makeRpcDecimalsCache,
  sqrtPriceX96ToPrice,
  getTokenUsdcValue,
  type PairMidResult,
} from './tokenPricing.js';

// ── Anchor token allowlist (Base) ────────────────────────────────────────────

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH = '0x4200000000000000000000000000000000000006';

/** Stablecoins that anchor a receipt directly to USD (~$1). */
const STABLECOINS: ReadonlySet<string> = new Set([USDC, USDBC, DAI]);

/** Known symbols — avoid an RPC round-trip for common tokens. */
const KNOWN_SYMBOLS: ReadonlyMap<string, string> = new Map([
  [USDC, 'USDC'],
  [USDBC, 'USDbC'],
  [DAI, 'DAI'],
  [WETH, 'WETH'],
]);

const isStable = (t: string): boolean => STABLECOINS.has(t.toLowerCase());
const isWeth = (t: string): boolean => t.toLowerCase() === WETH;
/** A token anchors to USD if it's a stablecoin or WETH (priced via WETH/USD). */
const anchorsToUsd = (t: string): boolean => isStable(t) || isWeth(t);

const isUsdcWethPair = (input: string, output: string): boolean => {
  const i = input.toLowerCase();
  const o = output.toLowerCase();
  return (i === USDC && o === WETH) || (i === WETH && o === USDC);
};

// ── Result interface ─────────────────────────────────────────────────────────

export interface PricingResult {
  status: 'full' | 'partial';
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
}

// ── DI seam ──────────────────────────────────────────────────────────────────

export interface PricingDeps {
  /** WETH/USDC oracle-validated benchmark (samples at blockNumber-1 internally). */
  benchmark: (args: { rpcUrl: string; blockNumber: bigint }) => Promise<BenchmarkResult>;
  /** Deepest-pool mid: output(tokenOut)-per-input(tokenIn) at `blockNumber`. */
  getPairMid: (tokenIn: string, tokenOut: string, blockNumber: bigint) => Promise<PairMidResult | null>;
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
export interface PoolMidReaders {
  /** Deepest initialized pool for the already address-sorted (token0, token1) pair. */
  getDeepestPool: (
    token0: string,
    token1: string,
    blockNumber: bigint,
  ) => Promise<{ address: string; kind: string } | null>;
  /** Raw `slot0` sqrtPriceX96 read for a given pool address. */
  readSlot0: (poolAddress: string, blockNumber: bigint) => Promise<bigint | null>;
  readDecimals: (address: string) => Promise<number>;
}

/**
 * Compute an arbitrary-pair mid from the deepest on-chain pool.
 *
 * `getDeepestPoolForPair` returns V3-style pools only, so the mid is always a
 * `slot0` read. `sqrtPriceX96ToPrice` yields token1-per-token0 (Uniswap sort
 * order, lower address = token0); we invert when the caller's `tokenIn` is the
 * higher address so the result is always output-per-input.
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

  const sqrtPriceX96 = await readers.readSlot0(pool.address, blockNumber);
  if (sqrtPriceX96 === null) return null;

  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  const rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1); // token1 per token0
  const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
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
      };
    }

    // ── Branch 2/3: generic pair ──
    const mid = await deps.getPairMid(inputToken, outputToken, refBlock);
    const anchored = anchorsToUsd(inputToken) || anchorsToUsd(outputToken);

    if (mid !== null && mid.price > 0 && anchored) {
      const notionalUsd = await bestEffortNotional(deps, args, refBlock);
      return {
        status: 'full',
        marketMid: mid.price,
        notionalUsd,
        inputSymbol,
        outputSymbol,
        inputDecimals,
        outputDecimals,
        chainlinkPrice: null,
        poolDivergenceBps: null,
        manipulationFlag: false,
      };
    }

    // No reliable mid, or no USD anchor → partial (notionalUsd still best-effort).
    const notionalUsd = await bestEffortNotional(deps, args, refBlock);
    return partial(notionalUsd);
  } catch {
    // Any failure (transient RPC, decode, etc.) degrades to partial — never throw.
    return partial(null);
  }
}

/**
 * Best-effort USD notional: value the input side first, then the output side.
 * Any error swallows to null (the caller decides full vs partial independently).
 */
async function bestEffortNotional(
  deps: PricingDeps,
  args: { inputToken: string; outputToken: string; inputAmountRaw: bigint; outputAmountRaw: bigint },
  refBlock: bigint,
  precomputedWethUsd?: number,
): Promise<number | null> {
  try {
    const fromInput = await deps.getUsdValue(args.inputToken, args.inputAmountRaw, refBlock, precomputedWethUsd);
    if (fromInput != null && fromInput > 0) return fromInput;
  } catch {
    // fall through to output side
  }
  try {
    const fromOutput = await deps.getUsdValue(args.outputToken, args.outputAmountRaw, refBlock, precomputedWethUsd);
    if (fromOutput != null && fromOutput > 0) return fromOutput;
  } catch {
    // give up
  }
  return null;
}
