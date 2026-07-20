/**
 * marketPrice.ts — the single Market Price apparatus (pure reducer).
 *
 * ONE ruler: every estimator here prices the SAME output-per-input scalar for
 * the traded pair. Estimators of different CLASSES (a direct pool mid, a WETH
 * bridge, an oracle-implied ratio) corroborate that one number; they are never
 * used to price the two sides of the swap separately. See
 * docs/superpowers/specs/2026-07-20-single-ruler-market-price-design.md.
 */
import { median } from './benchmarkPrice.js';

export type MarketPriceTier = 'full' | 'estimated' | 'none';
export type EstimatorClass = 'direct' | 'bridged' | 'oracle';

export interface Estimator {
  /** output-per-input price for the pair, human units. */
  price: number;
  class: EstimatorClass;
  /** provenance for the methodology string, e.g. "direct pool". */
  label: string;
}

export interface MarketPriceResult {
  tier: MarketPriceTier;
  /** output-per-input mid; null iff tier === 'none'. */
  marketMid: number | null;
  corroboratedBy: EstimatorClass[];
  flags: string[];
}

/** Cross-class agreement tolerance (matches benchmark MANIPULATION_TOL_BPS). */
export const CORROBORATE_TOL_BPS = 50;

const LIQUIDITY_CLASSES: EstimatorClass[] = ['direct', 'bridged'];

export function computeMarketPrice(
  estimators: Estimator[],
  tolBps: number = CORROBORATE_TOL_BPS,
): MarketPriceResult {
  const valid = estimators.filter((e) => Number.isFinite(e.price) && e.price > 0);

  // The mid is pool-relative: it comes ONLY from liquidity classes. Median within
  // each class first, then the mid is the median across the liquidity classes.
  const liq = new Map<EstimatorClass, number>();
  for (const cls of LIQUIDITY_CLASSES) {
    const prices = valid.filter((e) => e.class === cls).map((e) => e.price);
    if (prices.length > 0) liq.set(cls, median(prices));
  }
  if (liq.size === 0) {
    return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'] };
  }

  const liqClasses = [...liq.keys()];
  const marketMid = median([...liq.values()]);
  const within = (p: number) => (Math.abs(p - marketMid) / marketMid) * 10_000 <= tolBps;

  const flags: string[] = [];
  const corroboratedBy: EstimatorClass[] = [];
  for (const c of liqClasses) if (within(liq.get(c)!)) corroboratedBy.push(c);

  // Independent liquidity corroboration: >=2 liquidity classes that all agree.
  const liquidityCorroborated = liqClasses.length >= 2 && liqClasses.every((c) => within(liq.get(c)!));
  if (liqClasses.length >= 2 && !liquidityCorroborated) flags.push('LIQUIDITY_DISAGREE');

  // Oracle: corroborate-only. It confirms the tier but never enters the mid.
  const oraclePrices = valid.filter((e) => e.class === 'oracle').map((e) => e.price);
  let oracleCorroborated = false;
  if (oraclePrices.length > 0) {
    if (within(median(oraclePrices))) {
      oracleCorroborated = true;
      corroboratedBy.push('oracle');
    } else {
      flags.push('ORACLE_DISAGREE');
    }
  }

  const corroborated = liquidityCorroborated || oracleCorroborated;
  if (!corroborated && flags.length === 0) flags.push('SINGLE_SOURCE');
  return { tier: corroborated ? 'full' : 'estimated', marketMid, corroboratedBy, flags };
}

/**
 * The single-ruler identity: from ONE market mid, the dollar execution result and
 * the bps execution quality are two views of the same number. A test asserts
 * execResultUsd === qualityBps/1e4 * notionalUsd; if that ever breaks, a second
 * ruler has re-entered. All prices are output-per-input.
 */
export function reconciledResult(args: {
  marketMid: number;
  realizedPrice: number;
  notionalUsd: number;
}): { execResultUsd: number; qualityBps: number } {
  const ratio = args.realizedPrice / args.marketMid - 1;
  return { execResultUsd: args.notionalUsd * ratio, qualityBps: ratio * 10_000 };
}

export interface MarketPriceDeps {
  /** Guarded deepest direct pool mid (output-per-input), or null. */
  getDirectMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
  /** (in/WETH) x (WETH/out) bridged mid (output-per-input), or null. */
  getBridgedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
  /** usd(in)/usd(out) implied ratio when BOTH sides have USD feeds, else null. */
  getOracleImpliedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
}

async function safeMid(
  fn: (a: string, b: string, blk: bigint) => Promise<number | null>,
  a: string, b: string, blk: bigint,
): Promise<number | null> {
  try {
    return await fn(a, b, blk);
  } catch {
    return null;
  }
}

export async function getMarketPriceForPair(
  deps: MarketPriceDeps,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
): Promise<MarketPriceResult> {
  const [d, b, o] = await Promise.all([
    safeMid(deps.getDirectMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getBridgedMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getOracleImpliedMid, inputToken, outputToken, blockNumber),
  ]);
  const estimators: Estimator[] = [];
  if (d != null) estimators.push({ price: d, class: 'direct', label: 'direct pool' });
  if (b != null) estimators.push({ price: b, class: 'bridged', label: 'WETH bridge' });
  if (o != null) estimators.push({ price: o, class: 'oracle', label: 'oracle ratio' });
  return computeMarketPrice(estimators);
}
