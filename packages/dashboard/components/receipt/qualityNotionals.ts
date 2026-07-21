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
// Import from the pure leaf subpath (NOT the barrel): the barrel re-exports
// analyzeTransaction → tagging → node:fs, which webpack cannot bundle for the
// 'use client' tree. See packages/core/src/receiptPure.ts.
import { reconciledResult, baseIsOutputLeg, anchorsToUsd } from '@fabric-tca/core/pure';

// A token independently anchors to USD when it's a stablecoin (≈ $1) or ETH/WETH
// (priced via the benchmark mid). Tier-independent — it says the pair *has* a USD
// tie-point, not that any particular mid is trustworthy.
export function isAnchorable(symbol: string): boolean {
	return STABLE_SYMBOLS.has(symbol) || ETH_SYMBOLS.has(symbol);
}

/**
 * Single-ruler per-side USD notionals + Execution Result. Stored marketMid is
 * DISPLAY-oriented (core's toDisplayPrice inverts it for base-is-output pairs), but
 * reconciledResult needs output-per-input — so un-invert with the SAME core predicate
 * (baseIsOutputLeg) and take realized straight from the raw amounts (orientation-free).
 * Anchor detection uses core's address-based anchorsToUsd so the side we pin notionalUsd
 * to matches exactly what bestEffortNotional valued. Feeds reconciledResult the INPUT
 * (paid) notional, so execResult = notionalOut - notionalIn holds exactly. Null unless a
 * side anchors and a usable mid exists.
 */
export function receiptDollars(
	row: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputAmount' | 'outputAmount' | 'marketMid' | 'notionalUsd'>,
): { notionalIn: number; notionalOut: number; execResultUsd: number } | null {
	const inAmt = Number(row.inputAmount);
	const outAmt = Number(row.outputAmount);
	const midStored = row.marketMid == null ? null : Number(row.marketMid);
	const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
	if (midStored == null || notional == null) return null;
	if (![inAmt, outAmt, midStored, notional].every(Number.isFinite) || inAmt <= 0 || outAmt <= 0 || midStored <= 0) return null;
	// Token addresses are required to detect anchoring/orientation; a row missing them
	// (never the case in production) degrades to the non-anchored path rather than throwing.
	if (typeof row.inputToken !== 'string' || typeof row.outputToken !== 'string') return null;
	const inAnchor = anchorsToUsd(row.inputToken);
	const outAnchor = anchorsToUsd(row.outputToken);
	if (!inAnchor && !outAnchor) return null;
	const baseIsOutput = baseIsOutputLeg(row.inputToken, row.outputToken);
	const midOPi = baseIsOutput ? 1 / midStored : midStored; // output-per-input
	const realizedOPi = outAmt / inAmt;                        // output-per-input, orientation-free
	const preferOutput = outAnchor && !inAnchor;               // stored notionalUsd is the OUTPUT side
	const notionalIn = preferOutput ? (notional * midOPi) / realizedOPi : notional;
	const { execResultUsd } = reconciledResult({ marketMid: midOPi, realizedPrice: realizedOPi, notionalUsd: notionalIn });
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
