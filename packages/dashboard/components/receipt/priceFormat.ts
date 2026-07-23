/**
 * priceFormat — pure price-delta and base/quote orientation helpers for the receipt.
 * Split out of ReceiptView.tsx (2026-07-21). No JSX, no React: string/number logic.
 */
import type { ReceiptRow } from '../../lib/queries';
import { formatPriceMagnitude, formatSubvalueUsd } from './receiptDisplay';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './symbols';

/**
 * Price Delta value: the gap between the market mid and the executed rate, in
 * the pair's quote token — the same quote-per-base convention the Execution and
 * Market Price rows above it use, formatted by the same rule. Unsigned; the
 * tooltip carries the direction. Computed from the STORED values, not the rounded
 * ones on screen, so the delta is derived like every other number on the receipt.
 * An exact tie is "None" — there is no delta to describe, so no tooltip either.
 */
export function formatPriceDelta(marketMid: unknown, realizedPrice: unknown, quoteSymbol: string): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	const delta = Math.abs(mid - exec);
	if (delta === 0) return 'None';
	return `${formatPriceMagnitude(delta, quoteSymbol)} ${quoteSymbol}`;
}

/** A Price Delta row: the sentence, plus the "per 1 {base}" qualifier as a subvalue. */
export interface PriceDeltaRow {
	text: string;
	sub: string | null;
}

/**
 * The shared Price Delta sentence. Base symbol leads, then the verb implied by the
 * trade direction, the magnitude, and where the fill landed — e.g. "WBTC bought at
 * $159.76 below Market Price". Verb and direction stay independent facts whose
 * combination carries the verdict without stating one (bought below / sold above are
 * the favorable halves). This used to live in a tooltip; it is now the value itself,
 * with "per 1 {base}" split out as the subvalue per the Figma frame.
 */
function priceDeltaSentence(
	base: string,
	baseIsOutput: boolean,
	magnitude: string,
	direction: 'above' | 'below',
): PriceDeltaRow {
	return {
		text: `${base} ${baseIsOutput ? 'bought' : 'sold'} at ${magnitude} ${direction} Market Price`,
		sub: `per 1 ${base}`,
	};
}

/**
 * Anchored Price Delta: the per-base USD gap vs Market Price. USD, not
 * token-denominated — used only when receiptDollars anchored the pair. Direction is
 * derived from the SAME execResultUsd that drives the Spread row, so the two can
 * never disagree (bought below / sold above are the favorable halves = a gain).
 */
export function formatPriceDeltaUsd(
	deltaUsdPerBase: number,
	base: string,
	baseIsOutput: boolean,
	execResultUsd: number,
): PriceDeltaRow {
	if (!(deltaUsdPerBase > 0) || execResultUsd === 0) return { text: 'None', sub: null };
	const gain = execResultUsd > 0;
	const direction = gain === baseIsOutput ? 'below' : 'above';
	return priceDeltaSentence(base, baseIsOutput, formatSubvalueUsd(deltaUsdPerBase), direction);
}

/**
 * Non-anchored Price Delta: the same sentence shape, denominated in the quote token
 * instead of USD. Direction comes from priceDeltaDirection (a fact about the raw
 * stored prices) rather than from a dollar result, since an unanchored pair has none.
 * A tie or an unusable input degrades to the bare placeholder with no subvalue —
 * there is no delta to qualify.
 */
export function formatPriceDeltaToken(
	marketMid: unknown,
	realizedPrice: unknown,
	base: string,
	quote: string,
	baseIsOutput: boolean,
): PriceDeltaRow {
	const magnitude = formatPriceDelta(marketMid, realizedPrice, quote);
	const direction = priceDeltaDirection(marketMid, realizedPrice);
	if (direction == null) return { text: magnitude, sub: null };
	return priceDeltaSentence(base, baseIsOutput, magnitude, direction);
}

/**
 * Market Price methodology descriptor for rows whose `methodology` column is NULL.
 *
 * Every receipt persisted to date predates that column being populated, so without a
 * fallback the descriptor line renders empty. Mirrors core's `methodologyFor`
 * (packages/core/src/pricing.ts) at tier granularity — the stored string is more
 * specific (it names the corroborating estimators) and always wins when present.
 */
export function fallbackMethodology(pricingStatus: string): string {
	if (pricingStatus === 'full') return 'Verified: market price corroborated across sources.';
	if (pricingStatus === 'estimated') return 'Estimated: market price is uncorroborated.';
	return 'Unavailable: No reliable market price could be calculated.';
}

/**
 * Where the fill landed relative to the mid. Deliberately NOT direction-aware:
 * this states a fact about the price, so it needs no notion of who was buying.
 * The tooltip pairs it with bought/sold and lets the reader draw the conclusion;
 * Total Execution Quality is the row that renders a verdict. That split is what
 * keeps this safe — an earlier version used above/below AS the verdict, which
 * hard-coded 'higher is better' and inverted on every buy.
 *
 * Reads the raw stored mid/realized in every case (USD-anchored, ETH-quoted, and
 * no-anchor alike): the display rescale that used to be applied is strictly
 * positive (marketUsd − execUsd = execUsd·(mm−rp)/rp, with execUsd > 0, rp > 0),
 * so it can never flip the sign. Null on an exact tie — matching formatPriceDelta's
 * "None", so the value and the tooltip can never disagree.
 */
export function priceDeltaDirection(marketMid: unknown, realizedPrice: unknown): 'above' | 'below' | null {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return null;
	if (exec === mid) return null;
	return exec > mid ? 'above' : 'below';
}

// The title reads as the swap direction — inputSymbol → outputSymbol — so it
// always matches the Token In / Token Out rows below it (USDC → WETH shows
// "USDC → WETH", WARP → ETH shows "WARP → ETH"). Price rows are separately quoted
// USD-per-base and are unaffected by this ordering. input/output are populated
// consistently for seed and computed rows, so we never parse `direction`.
export function receiptPairTitle(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): string {
	return `${row.inputSymbol} → ${row.outputSymbol}`;
}

const NAMED_CHAINS: Record<number, string> = {
	1: 'Ethereum',
	10: 'Optimism',
	137: 'Polygon',
	8453: 'Base',
	42161: 'Arbitrum',
};

export function chainLabel(chainId: number): string {
	return NAMED_CHAINS[chainId] ?? `Chain ${chainId}`;
}

// Mirrors core's anchorRank: stablecoins outrank ETH/WETH, which outrank
// everything else. The stored realizedPrice/marketMid are quote-per-base,
// where base = the leg with the LOWER anchor rank (the more "volatile" side).
function symbolAnchorRank(symbol: string): number {
	if (STABLE_SYMBOLS.has(symbol)) return 2;
	if (ETH_SYMBOLS.has(symbol)) return 1;
	return 0;
}

// Resolves the base/quote symbols for a receipt's price rows, matching the
// orientation the DB already stores realizedPrice/marketMid in (quote-per-base).
// `baseIsOutput` is the trade direction relative to the base: true = the user
// bought the base, false = sold it. Price Delta's verdict depends on it.
export function pairBaseQuote(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): {
	base: string;
	quote: string;
	baseIsOutput: boolean;
} {
	const baseIsOutput = symbolAnchorRank(row.outputSymbol) < symbolAnchorRank(row.inputSymbol);
	return baseIsOutput
		? { base: row.outputSymbol, quote: row.inputSymbol, baseIsOutput }
		: { base: row.inputSymbol, quote: row.outputSymbol, baseIsOutput };
}

export const UNAVAILABLE = 'Unavailable for this pair';
