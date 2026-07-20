/**
 * "Was this a good trade?" — deferred.
 *
 * The receipt currently answers only "what happened in this trade" (see
 * docs/superpowers/specs/2026-07-14-receipt-mvp-decomposition-design.md).
 * `receiptDollars` below is the single-ruler USD helper: one stored anchor
 * notional (`notionalUsd`) + one `marketMid`, no second (oracle-derived) ruler.
 *
 * This module imports only leaf modules (receipt/symbols, receipt/usdFormat) and
 * a type-only import from lib/queries — never TradesTable or ReceiptView — so it
 * stays genuinely importable in isolation from the client component tree.
 */
import type { ReceiptRow } from '../../lib/queries';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './symbols';
import { formatUsdMagnitude } from './usdFormat';
import { reconciledResult } from '@fabric-tca/core';

// A token independently anchors to USD when it's a stablecoin (≈ $1) or ETH/WETH
// (priced via the benchmark mid). Tier-independent — it says the pair *has* a USD
// tie-point, not that any particular mid is trustworthy.
export function isAnchorable(symbol: string): boolean {
	return STABLE_SYMBOLS.has(symbol) || ETH_SYMBOLS.has(symbol);
}

/**
 * Single-ruler per-side USD notionals + Execution Result, from the ONE stored
 * anchor notional (`notionalUsd`) + the ONE `marketMid`. Feeds `reconciledResult`
 * the INPUT (paid) side notional so the identity execResult = notionalOut -
 * notionalIn holds exactly (see spec). Null unless a side anchors and a mid exists.
 */
export function receiptDollars(
	row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'marketMid' | 'notionalUsd' | 'realizedPrice'>,
): { notionalIn: number; notionalOut: number; execResultUsd: number } | null {
	const mid = row.marketMid == null ? null : Number(row.marketMid);
	const realized = row.realizedPrice == null ? null : Number(row.realizedPrice);
	const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
	if (mid == null || realized == null || notional == null) return null;
	if (![mid, realized, notional].every(Number.isFinite) || mid <= 0 || realized <= 0) return null;
	const inAnchor = isAnchorable(row.inputSymbol);
	const outAnchor = isAnchorable(row.outputSymbol);
	if (!inAnchor && !outAnchor) return null;
	const preferOutput = outAnchor && !inAnchor; // stored notionalUsd is the OUTPUT side
	const notionalIn = preferOutput ? (notional * mid) / realized : notional;
	const { execResultUsd } = reconciledResult({ marketMid: mid, realizedPrice: realized, notionalUsd: notionalIn });
	const notionalOut = notionalIn + execResultUsd;
	if (![notionalIn, notionalOut, execResultUsd].every(Number.isFinite)) return null;
	return { notionalIn, notionalOut, execResultUsd };
}

// Unsigned execution result: magnitude only. Direction is the `sub` label
// (Gained/Lost) + color — never a +/- prefix. Positive = surplus (green).
export function formatExecutionResult(execResultUsd: number): { text: string; sub: string | null; color: string | undefined } {
	const mag = formatUsdMagnitude(Math.abs(execResultUsd)) ?? '0.00';
	const text = `$${mag}`;
	if (execResultUsd > 0) return { text, sub: 'Gained', color: '#117d45' };
	if (execResultUsd < 0) return { text, sub: 'Lost', color: undefined };
	return { text, sub: null, color: undefined };
}
