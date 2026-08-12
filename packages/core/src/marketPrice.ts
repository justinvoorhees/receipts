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
  /**
   * Depth of the binding (thinnest) reference pool in USD, populated whether or
   * not the floor passed — a thin-but-passing ruler has to be visible too.
   * Always null out of `computeMarketPrice`, which sees prices and nothing else.
   */
  referenceDepthUsd: number | null;
  /** The pool that depth belongs to. Depth alone cannot be re-audited. */
  referencePoolAddress: string | null;
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
    return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'], referenceDepthUsd: null, referencePoolAddress: null };
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

  // full requires liquidity agreement, OR a single pool the oracle corroborates.
  // Two disagreeing pools are never rescued to "full" by an oracle near their
  // median (with two values each is equidistant from the median, so on disagreement
  // BOTH fall outside tolerance) — that case stays estimated + LIQUIDITY_DISAGREE.
  const corroborated = liquidityCorroborated || (liqClasses.length === 1 && oracleCorroborated);
  // SINGLE_SOURCE = exactly one liquidity class present and uncorroborated. It can
  // co-occur with ORACLE_DISAGREE (a lone pool the oracle contradicts) but never with
  // LIQUIDITY_DISAGREE (that requires >=2 classes). Tier is already 'estimated' here.
  if (!corroborated && liqClasses.length === 1) flags.push('SINGLE_SOURCE');
  return { tier: corroborated ? 'full' : 'estimated', marketMid, corroboratedBy, flags, referenceDepthUsd: null, referencePoolAddress: null };
}

// The single-ruler identity `reconciledResult` lives in the pure leaf (receiptPure)
// so the dashboard's client bundle can share it; re-exported here for the modules
// and tests that import it from marketPrice.
export { reconciledResult } from './receiptPure.js';

/**
 * A liquidity estimator's price plus what its reference pool looked like.
 *
 * The extra fields exist because a pool that failed the depth floor contributes
 * NOTHING to the estimator array — it is byte-identical to a pool that never
 * existed — so the reason cannot be recovered downstream and has to be carried
 * out of the dep itself.
 */
export interface MidOutcome {
  price: number | null;
  /** Depth of the pool used, in USD; null when it could not be valued. */
  depthUsd?: number | null;
  poolAddress?: string | null;
  /** A pool existed and was rejected for being below the USD floor. */
  rejected?: boolean;
  /** Depth could not be valued, so the floor was not applied. */
  unverified?: boolean;
}

export interface MarketPriceDeps {
  /** Guarded deepest direct pool mid (output-per-input), plus its pool evidence. */
  getDirectMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<MidOutcome>;
  /** (in/WETH) x (WETH/out) bridged mid (output-per-input), plus its pool evidence. */
  getBridgedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<MidOutcome>;
  /** usd(in)/usd(out) implied ratio when BOTH sides have USD feeds, else null.
   *  Stays a bare number: the oracle has no pool, so there is no depth to report. */
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

async function safeOutcome(
  fn: (a: string, b: string, blk: bigint) => Promise<MidOutcome>,
  a: string, b: string, blk: bigint,
): Promise<MidOutcome> {
  try {
    return await fn(a, b, blk);
  } catch {
    return { price: null };
  }
}

export async function getMarketPriceForPair(
  deps: MarketPriceDeps,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
): Promise<MarketPriceResult> {
  const [d, b, o] = await Promise.all([
    safeOutcome(deps.getDirectMid, inputToken, outputToken, blockNumber),
    safeOutcome(deps.getBridgedMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getOracleImpliedMid, inputToken, outputToken, blockNumber),
  ]);
  const estimators: Estimator[] = [];
  if (d.price != null) estimators.push({ price: d.price, class: 'direct', label: 'direct pool' });
  if (b.price != null) estimators.push({ price: b.price, class: 'bridged', label: 'WETH bridge' });
  if (o != null) estimators.push({ price: o, class: 'oracle', label: 'oracle ratio' });

  // computeMarketPrice stays UNTOUCHED and pure over its existing signature.
  const base = computeMarketPrice(estimators);

  // Merge what only this scope knows. When the floor is what emptied every
  // class the result carries BOTH NO_LIQUIDITY (from the reducer, which
  // correctly observed zero classes) and INSUFFICIENT_DEPTH (explaining why);
  // that co-occurrence is intended, and methodologyFor must branch on the
  // specific reason first.
  const flags = [...base.flags];
  if (d.rejected || b.rejected) flags.push('INSUFFICIENT_DEPTH');
  if (d.unverified || b.unverified) flags.push('DEPTH_UNVERIFIED');

  // These fields describe the ruler ACTUALLY IN USE, so a class that was floored
  // out must not claim them while another class is setting the mid — that would
  // tell the reader their benchmark is dust when it is not. Only when nothing
  // survived does the refused pool become the answer, because then it IS the
  // explanation for having no market price at all.
  const thinnestOf = (xs: MidOutcome[]) =>
    xs.length ? xs.reduce((lo, x) => ((x.depthUsd as number) < (lo.depthUsd as number) ? x : lo)) : null;
  const valued = [d, b].filter((x) => x.depthUsd != null);
  const thinnest = thinnestOf(valued.filter((x) => !x.rejected)) ?? thinnestOf(valued);

  return {
    ...base,
    flags,
    referenceDepthUsd: thinnest?.depthUsd ?? null,
    referencePoolAddress: thinnest?.poolAddress ?? null,
  };
}
