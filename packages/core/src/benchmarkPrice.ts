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
import { makeDuneEthUsdOracle, type OffChainOracle } from './duneOracle.js';

// Tolerances (see design spec 2026-06-26-robust-benchmark-oracle-validation).
// Max single-pool deviation from the median (NOT full spread). ~half the old metric.
export const DIVERGENCE_TOL_BPS = 15;
export const MANIPULATION_TOL_BPS = 50;
export const MIN_VALID_POOLS = 2;
export const MAX_CHAINLINK_STALENESS_SECS = 1200; // 20 min
export const MAX_OFFCHAIN_STALENESS_SECS = 1200;  // 20 min

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

export interface OracleInput { price: number; stale: boolean }

export interface BenchmarkResult {
  marketMid: number;
  perPool: { label: string; price: number | null }[];
  poolDivergenceBps: number;
  chainlinkPrice: number | null;
  chainlinkDevBps: number | null;
  offchainPrice: number | null;
  offchainDevBps: number | null;
  manipulationSuspect: boolean;
  flags: string[];
  lowConfidence: boolean;
  chainlinkStalenessSecs: number | null;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median: empty input');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function computeBenchmark(
  perPool: { label: string; price: number | null }[],
  oracles: { chainlink: OracleInput | null; offChain: OracleInput | null },
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

  const devBps = (oracle: number) => (Math.abs(marketMid - oracle) / oracle) * 10_000;

  // Record raw deviations (vs. each oracle's own price) for audit, regardless of usability.
  const chainlinkPrice = oracles.chainlink?.price ?? null;
  const offchainPrice = oracles.offChain?.price ?? null;
  const chainlinkDevBps = chainlinkPrice != null ? devBps(chainlinkPrice) : null;
  const offchainDevBps = offchainPrice != null ? devBps(offchainPrice) : null;

  // Availability flags.
  if (oracles.chainlink == null) flags.push('CHAINLINK_UNAVAILABLE');
  if (oracles.offChain == null) flags.push('OFFCHAIN_UNAVAILABLE');

  // Staleness flags (oracle present but stale → downgrade, not usable for manipulation).
  if (oracles.chainlink?.stale) { flags.push('CHAINLINK_STALE'); lowConfidence = true; }
  if (oracles.offChain?.stale) { flags.push('OFFCHAIN_STALE'); lowConfidence = true; }

  const usable: number[] = [];
  if (oracles.chainlink && !oracles.chainlink.stale) usable.push(oracles.chainlink.price);
  if (oracles.offChain && !oracles.offChain.stale) usable.push(oracles.offChain.price);

  let manipulationSuspect = false;
  if (usable.length === 0) {
    flags.push('ORACLE_UNAVAILABLE'); // cannot assert manipulation
  } else if (usable.length === 1) {
    if (devBps(usable[0]!) > MANIPULATION_TOL_BPS) {
      manipulationSuspect = true; flags.push('MANIPULATION_SUSPECT'); lowConfidence = true;
    }
  } else {
    const [c, o] = usable as [number, number];
    const mutualDevBps = (Math.abs(c - o) / ((c + o) / 2)) * 10_000;
    if (mutualDevBps > MANIPULATION_TOL_BPS) {
      flags.push('ORACLE_DISAGREE'); lowConfidence = true; // can't tell which is right
    } else {
      const consensus = (c + o) / 2;
      if ((Math.abs(marketMid - consensus) / consensus) * 10_000 > MANIPULATION_TOL_BPS) {
        manipulationSuspect = true; flags.push('MANIPULATION_SUSPECT'); lowConfidence = true;
      }
    }
  }

  return {
    marketMid, perPool, poolDivergenceBps,
    chainlinkPrice, chainlinkDevBps,
    offchainPrice, offchainDevBps,
    manipulationSuspect, flags, lowConfidence,
    chainlinkStalenessSecs: null,
  };
}

export async function getBenchmarkMid(args: {
  rpcUrl: string;
  blockNumber: bigint;
  offChainOracle?: OffChainOracle;
}): Promise<BenchmarkResult> {
  const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const at = args.blockNumber - 1n;

  const offChainOracle: OffChainOracle = args.offChainOracle
    ?? (process.env.DUNE_API_KEY ? makeDuneEthUsdOracle(process.env.DUNE_API_KEY) : async () => null);

  const [perPool, block] = await Promise.all([
    Promise.all(
      BENCHMARK_POOLS.map(async (pool) => {
        const sqrtPriceX96 = await readSlot0Sqrt(client as PublicClient, pool.address, at);
        return { label: pool.label, price: sqrtPriceX96 === null ? null : sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96) };
      }),
    ),
    client.getBlock({ blockNumber: at }),
  ]);
  const blockTs = Number(block.timestamp);

  // Chainlink
  let chainlink: OracleInput | null = null;
  let chainlinkStalenessSecs: number | null = null;
  try {
    const round = await client.readContract({
      address: CHAINLINK_ETH_USD, abi: CHAINLINK_ABI, functionName: 'latestRoundData', blockNumber: at,
    });
    const price = Number(round[1]) / 1e8;
    chainlinkStalenessSecs = blockTs - Number(round[3]); // updatedAt is field index 3
    chainlink = { price, stale: chainlinkStalenessSecs > MAX_CHAINLINK_STALENESS_SECS };
  } catch {
    chainlink = null;
  }

  // Off-chain (Dune)
  let offChain: OracleInput | null = null;
  try {
    const off = await offChainOracle(blockTs);
    if (off) offChain = { price: off.price, stale: blockTs - off.asOfSecs > MAX_OFFCHAIN_STALENESS_SECS };
  } catch {
    offChain = null;
  }

  return { ...computeBenchmark(perPool, { chainlink, offChain }), chainlinkStalenessSecs };
}
