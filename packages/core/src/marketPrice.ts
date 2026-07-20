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

const CLASS_PRIORITY: EstimatorClass[] = ['direct', 'bridged', 'oracle'];

export function computeMarketPrice(
  estimators: Estimator[],
  tolBps: number = CORROBORATE_TOL_BPS,
): MarketPriceResult {
  const valid = estimators.filter((e) => Number.isFinite(e.price) && e.price > 0);
  if (valid.length === 0) {
    return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] };
  }

  // Reduce to one price per class (median of that class's pools/reads).
  const byClass = new Map<EstimatorClass, number>();
  for (const cls of CLASS_PRIORITY) {
    const prices = valid.filter((e) => e.class === cls).map((e) => e.price);
    if (prices.length > 0) byClass.set(cls, median(prices));
  }

  const classes = [...byClass.keys()];
  if (classes.length === 1) {
    const only = classes[0]!;
    return { tier: 'estimated', marketMid: byClass.get(only)!, corroboratedBy: [only], flags: ['SINGLE_CLASS'] };
  }

  // >=2 classes: the agreeing subset is those within tol of all class prices' median.
  const classPrices = classes.map((c) => byClass.get(c)!);
  const m = median(classPrices);
  const agree = classes.filter((c) => (Math.abs(byClass.get(c)! - m) / m) * 10_000 <= tolBps);

  if (agree.length >= 2) {
    return {
      tier: 'full',
      marketMid: median(agree.map((c) => byClass.get(c)!)),
      corroboratedBy: agree,
      flags: [],
    };
  }

  // No corroboration: fall back to the highest-priority class, flagged.
  const pick = CLASS_PRIORITY.find((c) => byClass.has(c))!;
  return { tier: 'estimated', marketMid: byClass.get(pick)!, corroboratedBy: [pick], flags: ['CROSS_CLASS_DISAGREE'] };
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
