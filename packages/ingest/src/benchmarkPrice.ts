/**
 * benchmarkPrice.ts — Robust WETH/USDC reference mid at block N-1.
 *
 * Replaces the single-hardcoded-pool slot0 read. Reads the three deepest
 * WETH/USDC pools, takes the median (instantaneous-mid semantics preserved),
 * and cross-checks the median against the Chainlink ETH/USD oracle to flag
 * possible pre-block manipulation.
 */
import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { sqrtPriceX96ToUsdcPerWeth } from './referencePrice.js';

// Tolerances (see design spec 2026-06-26-robust-benchmark-oracle-validation).
// Max single-pool deviation from the median (NOT full spread). ~half the old metric.
export const DIVERGENCE_TOL_BPS = 15;
export const MANIPULATION_TOL_BPS = 50;
export const MIN_VALID_POOLS = 2;

/** Three deepest WETH/USDC pools on Base. token0 = WETH for all (10^12 adjust). */
export const BENCHMARK_POOLS: { label: string; address: `0x${string}` }[] = [
  { label: 'univ3_5bps', address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' },
  { label: 'univ3_30bps', address: '0x6c561B446416E1A00E8E93E221854d6eA4171372' },
  { label: 'aero_cl', address: '0xdbc6998296caA1652A810dc8D3BaF4A8294330f1' },
];

/** Chainlink ETH/USD feed on Base (8 decimals). Confirmed on-chain (Task 1). */
export const CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as `0x${string}`;

const CHAINLINK_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Minimal slot0 ABI — decodes ONLY the leading `sqrtPriceX96` word.
 *
 * Uniswap V3 pools return `slot0()` as a 7-field tuple ending in
 * `uint8 feeProtocol, bool unlocked`; Aerodrome CL / Slipstream pools return a
 * different tuple (no `feeProtocol`). Decoding the full V3 tuple against an
 * Aerodrome pool reverts in viem ("position out of bounds"), which is why the
 * shared `poolDiscovery.readSlot0` returned null for `aero_cl`. `sqrtPriceX96`
 * is the first storage word in every variant, so decoding only that one output
 * yields the correct value for BOTH pool families (viem ignores trailing data).
 */
const SLOT0_SQRT_ABI = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96)']);

/**
 * Read `sqrtPriceX96` from any V3-style pool (Uniswap V3 or Aerodrome CL).
 * Mirrors the old `readSlot0` semantics: returns null on revert/error, and
 * treats a zero price as null (uninitialized pool).
 */
async function readSlot0Sqrt(
  client: PublicClient,
  poolAddress: `0x${string}`,
  blockNumber: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: poolAddress,
      abi: SLOT0_SQRT_ABI,
      functionName: 'slot0',
      blockNumber,
    });
    return result > 0n ? result : null;
  } catch {
    return null;
  }
}

export interface BenchmarkResult {
  marketMid: number;
  perPool: { label: string; price: number | null }[];
  poolDivergenceBps: number;
  chainlinkPrice: number | null;
  chainlinkDevBps: number | null;
  manipulationSuspect: boolean;
  flags: string[];
  lowConfidence: boolean;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median: empty input');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function computeBenchmark(
  perPool: { label: string; price: number | null }[],
  chainlinkPrice: number | null,
): BenchmarkResult {
  const flags: string[] = [];
  let lowConfidence = false;

  const valid = perPool.filter((p): p is { label: string; price: number } => p.price != null && p.price > 0);
  if (valid.length === 0) throw new Error('computeBenchmark: no valid pool prices');

  const prices = valid.map((p) => p.price);
  const marketMid = median(prices);

  let poolDivergenceBps = 0;
  if (valid.length < MIN_VALID_POOLS) {
    flags.push('LOW_POOL_COVERAGE');
    lowConfidence = true;
  } else {
    const maxDevFromMedian = Math.max(...prices.map((p) => Math.abs(p - marketMid)));
    poolDivergenceBps = (maxDevFromMedian / marketMid) * 10_000;
    if (poolDivergenceBps > DIVERGENCE_TOL_BPS) {
      flags.push('POOL_DIVERGENCE');
      lowConfidence = true;
    }
  }

  let chainlinkDevBps: number | null = null;
  let manipulationSuspect = false;
  if (chainlinkPrice == null) {
    flags.push('CHAINLINK_UNAVAILABLE');
  } else {
    // Chainlink is ETH/USD; mid is USDC/WETH. USDC depeg (<10bps) sits inside the
    // 50bps tolerance, so the USDC != USD gap does not false-trigger.
    chainlinkDevBps = (Math.abs(marketMid - chainlinkPrice) / chainlinkPrice) * 10_000;
    if (chainlinkDevBps > MANIPULATION_TOL_BPS) {
      manipulationSuspect = true;
      flags.push('MANIPULATION_SUSPECT');
      lowConfidence = true;
    }
  }

  return { marketMid, perPool, poolDivergenceBps, chainlinkPrice, chainlinkDevBps, manipulationSuspect, flags, lowConfidence };
}

export async function getBenchmarkMid(args: { rpcUrl: string; blockNumber: bigint }): Promise<BenchmarkResult> {
  const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const at = args.blockNumber - 1n;

  const perPool = await Promise.all(
    BENCHMARK_POOLS.map(async (pool) => {
      const sqrtPriceX96 = await readSlot0Sqrt(client as never, pool.address, at);
      return { label: pool.label, price: sqrtPriceX96 === null ? null : sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96) };
    }),
  );

  let chainlinkPrice: number | null = null;
  try {
    const round = await client.readContract({
      address: CHAINLINK_ETH_USD,
      abi: CHAINLINK_ABI,
      functionName: 'latestRoundData',
      blockNumber: at,
    });
    chainlinkPrice = Number(round[1]) / 1e8; // 8 decimals
  } catch {
    chainlinkPrice = null;
  }

  return computeBenchmark(perPool, chainlinkPrice);
}
