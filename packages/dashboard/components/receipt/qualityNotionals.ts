/**
 * "Was this a good trade?" — deferred.
 *
 * These helpers value each side of a swap in USD and compare them, which is a
 * fair-value claim. The receipt currently answers only "what happened in this
 * trade" (see docs/superpowers/specs/2026-07-14-receipt-mvp-decomposition-design.md),
 * so nothing here is wired into ReceiptView.
 *
 * They are kept — with their tests running — because that question is worth
 * answering once the decomposition is validated. The known gap they exposed:
 * for the reference ETH→WBTC row, valuing WBTC at the BTC/USD oracle instead of
 * the pool mid turned an apparent +$4.57 into ≈flat, because the pool's WBTC
 * price sat ~28bps above real BTC. That "venue basis" term is what a future
 * phase needs to surface for the two numbers to reconcile under one ruler.
 *
 * Core still forward-populates `anchor_price_usd` (migration 0014), so this
 * resumes as a re-wire rather than a re-derivation.
 *
 * This module imports only leaf modules (receipt/symbols, receipt/usdFormat) and
 * a type-only import from lib/queries — never TradesTable or ReceiptView — so it
 * stays genuinely importable in isolation from the client component tree.
 */
import type { ReceiptRow } from '../../lib/queries';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './symbols';
import { formatUsdMagnitude } from './usdFormat';

// A token independently anchors to USD when it's a stablecoin (≈ $1) or ETH/WETH
// (priced via the benchmark mid). Tier-independent — it says the pair *has* a USD
// tie-point, not that any particular mid is trustworthy.
export function isAnchorable(symbol: string): boolean {
	return STABLE_SYMBOLS.has(symbol) || ETH_SYMBOLS.has(symbol);
}

/**
 * For an ETH/WETH-quoted pair (one leg is WETH/native ETH, neither leg a
 * stablecoin), the stored realizedPrice/marketMid are ETH-per-base, not USD.
 * Re-express the price rows in USD-per-base from stored fields. Returns null for
 * stablecoin-quoted or unpriceable receipts (caller keeps the existing path).
 */
export function usdPerBasePrices(row: Pick<ReceiptRow,
	'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' |
	'realizedPrice' | 'marketMid' | 'notionalUsd'>
): { execUsd: number; marketUsd: number | null } | null {
	const inSym = row.inputSymbol;
	const outSym = row.outputSymbol;
	if (STABLE_SYMBOLS.has(inSym) || STABLE_SYMBOLS.has(outSym)) return null; // stable-quoted → already USD
	const inIsEth = ETH_SYMBOLS.has(inSym);
	const outIsEth = ETH_SYMBOLS.has(outSym);
	if (inIsEth === outIsEth) return null; // need exactly one ETH leg; the OTHER is base
	const baseAmount = Number(inIsEth ? row.outputAmount : row.inputAmount);
	const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
	const rp = row.realizedPrice == null ? null : Number(row.realizedPrice);
	const mm = row.marketMid == null ? null : Number(row.marketMid);
	if (notional == null || !Number.isFinite(notional) || !(baseAmount > 0)) return null;
	const execUsd = notional / baseAmount;
	const marketUsd =
		rp != null && mm != null && Number.isFinite(rp) && Number.isFinite(mm) && rp !== 0
			? execUsd * (mm / rp)
			: null;
	return { execUsd, marketUsd };
}

// A side's USD price marked at the benchmark mid: stablecoins are $1; for a
// stable↔ether pair the ether always sorts as `base`, so `marketMid` is the
// quote(≈USD)-per-ether price. Non-anchorable tokens have no defensible price.
function usdPriceAtMid(symbol: string, marketMid: number | null): number | null {
	if (STABLE_SYMBOLS.has(symbol)) return 1;
	if (ETH_SYMBOLS.has(symbol)) return marketMid;
	return null;
}

/**
 * Per-side USD notionals under the Phase-1 both-or-none rule: return a value for
 * each side only when BOTH sides can be independently valued at the mid (i.e. the
 * pair is double-anchored and the mid exists). Single- and no-anchor pairs return
 * both-null — we never show one notional and drop the other.
 */
export function perSideNotionals(
	row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'marketMid'>,
): { notionalIn: number | null; notionalOut: number | null } {
	const mid = row.marketMid == null ? null : Number(row.marketMid);
	const inUsd = usdPriceAtMid(row.inputSymbol, mid);
	const outUsd = usdPriceAtMid(row.outputSymbol, mid);
	if (inUsd == null || outUsd == null || !Number.isFinite(inUsd) || !Number.isFinite(outUsd)) {
		return { notionalIn: null, notionalOut: null };
	}
	return {
		notionalIn: Number(row.inputAmount) * inUsd,
		notionalOut: Number(row.outputAmount) * outUsd,
	};
}

/**
 * Per-side notionals for a SINGLE-anchor pair whose mid is validated (Phase 2a+).
 * The anchored side keeps its stored USD value (`notionalUsd`); the non-anchored
 * side — always the `base` (lower anchor rank) — is marked at the benchmark mid.
 * Returns null unless exactly one side anchors and a mid is available.
 */
export function singleAnchorNotionals(
	row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'notionalUsd' | 'marketMid' | 'realizedPrice' | 'anchorPriceUsd'>,
): { notionalIn: number; notionalOut: number; independent: boolean } | null {
	const inAnchor = isAnchorable(row.inputSymbol);
	const outAnchor = isAnchorable(row.outputSymbol);
	if (inAnchor === outAnchor) return null; // need exactly one anchored side
	const notionalUsd = row.notionalUsd == null ? null : Number(row.notionalUsd);
	if (notionalUsd == null || !Number.isFinite(notionalUsd)) return null;
	// Prefer the non-anchored side's OWN independent oracle price (a true second
	// valuation, e.g. WBTC via BTC/USD); else mark it at the benchmark mid
	// (USD-per-base for ETH-quoted pairs, else the stable-quoted mid is USD-per-base).
	const oracle = row.anchorPriceUsd == null ? null : Number(row.anchorPriceUsd);
	const independent = oracle != null && Number.isFinite(oracle) && oracle > 0;
	const usdP = usdPerBasePrices(row);
	const midPrice = usdP ? usdP.marketUsd : row.marketMid == null ? null : Number(row.marketMid);
	const basePrice = independent ? oracle : midPrice;
	if (basePrice == null || !Number.isFinite(basePrice)) return null;
	const baseIsOutput = !outAnchor; // the non-anchored side is the base
	const baseNotional = Number(baseIsOutput ? row.outputAmount : row.inputAmount) * basePrice;
	if (!Number.isFinite(baseNotional)) return null;
	return baseIsOutput
		? { notionalIn: notionalUsd, notionalOut: baseNotional, independent }
		: { notionalIn: baseNotional, notionalOut: notionalUsd, independent };
}

// Signed dollar execution result (notionalOut − notionalIn). Positive = surplus,
// shown green (matching formatDialogBps); negative keeps default color; both carry
// an explicit sign so a loss is unambiguous.
export function formatExecutionResult(gap: number): { text: string; color: string | undefined } {
	const mag = formatUsdMagnitude(gap) ?? '0.00';
	if (gap > 0) return { text: `+$${mag}`, color: '#117d45' };
	if (gap < 0) return { text: `-$${mag}`, color: undefined };
	return { text: '$0.00', color: undefined };
}

/**
 * Output-token difference vs marking the input at the benchmark mid, for no-anchor
 * pairs where a USD Price Delta would be false precision. No-anchor pairs always
 * resolve `base = input`, so `marketMid` is output-per-input. Null without a mid.
 */
export function outputTokenDelta(
	row: Pick<ReceiptRow, 'inputAmount' | 'outputAmount' | 'marketMid' | 'realizedPrice'>,
): number | null {
	if (row.marketMid == null || row.realizedPrice == null) return null;
	const mid = Number(row.marketMid);
	if (!Number.isFinite(mid)) return null;
	return Number(row.outputAmount) - Number(row.inputAmount) * mid;
}
