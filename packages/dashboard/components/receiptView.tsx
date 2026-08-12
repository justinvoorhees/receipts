'use client';
import { useEffect, useTransition } from 'react';
import { ReceiptSearch } from './receiptSearch';
import { rememberReceipt } from './receiptTransition';
import type { ReceiptModel } from '../lib/receiptModel';
import type { AnalyzeFailure } from '@fabric-tca/core';
import { shortTxHash, formatGasUsd } from '../lib/formatters';
import { DEFAULT_CHAIN, explorerTx } from '../lib/chains';
import {
	formatDialogBps,
	formatExecutionPrice,
	formatSubvalueUsd,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	getExecutionBreakdown,
	getPriceImpactRows,
	getAggregatorFeeLines,
	ShareButton,
	isMakerLeg,
	hasUnresolvedFee,
	UNRESOLVED_FEE_TOOLTIP,
	NULL_PRICE_TOOLTIP,
	NO_ROUTE_TOOLTIP,
	beneficiaryAnchorNote,
	isUniswapXFillerRow,
	UNATTRIBUTED_TOOLTIP,
	THIRD_PARTY_FEE_TOOLTIP,
} from './receipt/receiptDisplay';
import { receiptDollars } from './receipt/qualityNotionals';
import { dispersionClause } from './receipt/priceDispersion';
import type { PriceDeltaRow } from './receipt/priceFormat';
import {
	formatExecutionDelta,
	formatPriceDeltaToken,
	fallbackMethodology,
	receiptPairTitle,
	chainLabel,
	pairBaseQuote,
	UNAVAILABLE,
} from './receipt/priceFormat';
import {
	Divider,
	DetailRow,
	AggregatorValue,
	FillerRow,
	BkdHeading,
	BkdRow,
	LegRow,
	legContext,
	MethodologyText,
	MarketPriceTable,
} from './receipt/receiptRows';

// An unreadable block renders the same em dash the LP-fee rows use for an
// unresolved value. Never 0 — absent is not a measurement.
function formatMidCell(mid: unknown, base: string, quote: string): React.ReactNode {
	return mid == null ? '–' : formatExecutionPrice(mid, base, quote);
}

// A Cost Breakdown section (heading + its rows) gets 22px of extra bottom
// padding — but only when it actually has rows beneath the heading (Figma
// 546-713). A bare standalone heading (e.g. Third-Party Fee with no fee
// lines, or the unpriced Price Impact/Slippage pair) stays on the plain
// 20px rhythm and is never wrapped in this.
const GROUP_SECTION = 'flex flex-col gap-[20px] pb-[22px]';

export function ReceiptView({
	trade,
	hash,
	diagnosis,
	decoding = false,
}: {
	trade: ReceiptModel | null;
	hash: string;
	diagnosis?: AnalyzeFailure;
	/**
	 * This render IS the receipt route's Suspense fallback — the server is
	 * analyzing `hash` right now (see app/tx/[chain]/[hash]/page.tsx). Distinct
	 * from `isPending` below, which is a CLIENT transition this component
	 * started: a hard navigation runs no transition, so without this the shell
	 * for a shared link would sit there reading "Create Receipt" while decoding.
	 */
	decoding?: boolean;
}) {
	const [isPending, startTransition] = useTransition();
	// Only surface a failure when there is no receipt to show.
	const failure = trade === null ? diagnosis : undefined;

	// Outlive this component so the NEXT navigation's Suspense fallback can put
	// this receipt back on screen (see receiptTransition.ts). In an effect, not
	// in render: the store must never be written during SSR, where module state
	// is shared across requests. Skipped while `decoding`, or the fallback would
	// re-record the receipt it just read.
	useEffect(() => {
		if (trade != null && !decoding) rememberReceipt(trade);
	}, [trade, decoding]);

	return (
		<div className="flex flex-col gap-[40px]">
			<ReceiptSearch
				hash={hash}
				isPending={isPending}
				startTransition={startTransition}
				decoding={decoding}
				{...(failure ? { failure } : {})}
			/>
			{/* The rule under the input renders in EVERY state, including the empty
			    page (Figma 544-2386) — which is why it lives here and not at the top
			    of <Receipt>. */}
			<Divider />
			{/* Pulses on either signal: `isPending` is this component's own
			    transition, `decoding` means this render IS the fallback showing
			    the previous receipt while the next one is analyzed. */}
			{trade != null && (
				<div
					className={['flex flex-col gap-[40px]', pendingPulseClass(isPending || decoding)]
						.filter(Boolean)
						.join(' ')}
				>
					<Receipt row={trade} />
				</div>
			)}
		</div>
	);
}

/**
 * Pure so it's testable without a real transition: the class that pulses the
 * still-mounted receipt while a next one is being analyzed (Figma 701-1986,
 * .receipt-pending-pulse in globals.css).
 */
export function pendingPulseClass(isPending: boolean): string | undefined {
	return isPending ? 'receipt-pending-pulse' : undefined;
}

export function Receipt({
	row,
}: {
	row: ReceiptModel;
}) {
	const legs = normalizeRouteLegs(row.routeLegs);
	const showFillerRow = isUniswapXFillerRow(row);
	/**
	 * Did core reconstruct the route? This is the ONLY switch between the two
	 * receipts: the per-leg breakdown, and the "no route available" state where
	 * Third-Party Fee, L.P. Fee and Price Impact are all N/A.
	 *
	 * ⚠️ Do not re-derive this from the legs. The un-reconstructed path still
	 * emits legs (core's `venuesToUncostedLegs`) — corpus id 485 has a real
	 * `aerodrome_cl` leg and no reconstruction, and this transaction has a
	 * WETH9 wrap/unwrap pair that nets to nothing. A leg count answers "did we
	 * see any venues", which is a different question from "can we attribute".
	 *
	 * Rows persisted before core carried the field fall back to `true`, which
	 * keeps them on the breakdown they were rendered with.
	 *
	 * ⚠️ Deliberately NOT `&& legs.length > 0`. A reconstructed route with no
	 * legs keeps its own "No Route Found" row below — folding the two together
	 * reads as the same state but is not, and it silently reclassifies every
	 * receipt whose legs we simply have not populated.
	 */
	const routeReconstructed = row.routeReconstructed ?? true;
	// Partial receipts have no reference mid, so price/impact/slippage are null.
	// Guard every numeric read against null instead of `Number(null) === 0`.
	const isPartial = row.pricingStatus === 'partial';
	// Market Price / Price Delta render whenever a mid exists (full OR estimated).
	const hasMarketPrice = row.marketMid != null;
	// The methodology descriptor renders as a footnote bound to the Market Price row
	// (positional, not a *-linkage) on every tier, including the unpriced one.
	// Rows persisted before the column was populated fall back to a tier-derived string.
	const methodologyText = row.methodology ?? fallbackMethodology(row.pricingStatus);
	// Empty string when the triple is incomplete — see priceDispersion.ts.
	const dispersion = hasMarketPrice
		? dispersionClause(row.marketMidBefore, row.marketMid, row.marketMidAfter)
		: '';
	const feeLines = getAggregatorFeeLines(row);
	const hasAggFee = feeLines.length > 0;
	const priceImpactRows = getPriceImpactRows(legs, row);
	const pairTitle = receiptPairTitle(row);
	const { base, quote, baseIsOutput } = pairBaseQuote(row);
	// Single-ruler anchored state: receiptDollars is non-null iff a mid exists AND a
	// side anchors to USD (core address-based). Every anchored USD figure derives from
	// {notionalIn, notionalOut, execResultUsd} + the base (volatile) leg's amount.
	const dollars = receiptDollars(row);
	const anchored = dollars != null;
	// One source for all three renderings of the execution delta on this screen.
	// Anchored rows derive bps from the same reconciledResult that produces
	// execResultUsd (via receiptDollars); unanchored rows have no dollars object
	// and keep the stored column. execResultUsd is positive-for-good (opposite
	// polarity from allInCostBps's positive-for-cost), so it is negated here to
	// land on the same convention as the stored column before formatDialogBps
	// negates it again below for display.
	const costBps =
		dollars != null && dollars.notionalIn > 0
			? -(dollars.execResultUsd / dollars.notionalIn) * 10_000
			: row.allInCostBps != null
				? Number(row.allInCostBps)
				: null;
	const { text: accuracy, color: accuracyColor } = formatDialogBps(costBps == null ? null : -costBps);
	// Passed `costBps` so that when NOTHING could be attributed, the Unattributed
	// row is the same quantity Total Execution Delta prints — on a route with no
	// attributable parts those two rows are the same number by definition, and
	// deriving them from one source is what guarantees they never drift.
	const execution = getExecutionBreakdown(row, costBps);
	// Execution Delta states the gap on THIS trade; Price Delta states it per 1 base.
	// Same sentence, same direction source — they can never disagree.
	const executionDelta =
		dollars != null
			? formatExecutionDelta(dollars.execResultUsd, base, baseIsOutput, formatTokenIn(row))
			: null;
	// Price Delta now lives in the notional-free Price Range section (Task 8),
	// so it always states the gap in the quote token — never USD, even on an
	// anchored pair. The USD figure for the whole trade is Execution Delta's
	// job, in the top block. Direction lives in the text, so no tooltip.
	const priceDelta: PriceDeltaRow | null = !hasMarketPrice
		? null
		: formatPriceDeltaToken(row.marketMid, row.realizedPrice, base, quote, baseIsOutput);

	return (
		<>
			<div className="flex items-center justify-between">
				<h2 className="w-fit">
					<a
						href={explorerTx(DEFAULT_CHAIN, row.txHash)}
						target="_blank"
						rel="noreferrer"
						className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						{shortTxHash(row.txHash)}
					</a>
				</h2>
			</div>

			{/* Detail table */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				{showFillerRow ? (
					<FillerRow address={row.fillerAddress as string} />
				) : (
					<DetailRow label="Provider" labelSubValue={beneficiaryAnchorNote(row) ?? undefined}>
						<AggregatorValue row={row} />
					</DetailRow>
				)}
				<DetailRow label="Pair">{pairTitle}</DetailRow>
				<DetailRow label="Chain">{chainLabel(row.chainId)}</DetailRow>
				<DetailRow label="Block">{row.blockNumber.toLocaleString()}</DetailRow>

				{/* Anchored (single-ruler) → per-side USD + Execution Result, no Size.
				    Otherwise → the soft ~Size line for orientation (notionalUsd already
				    prefers the USD-anchored side via pricing.ts bestEffortNotional). */}
				{!anchored && (
					<DetailRow label="Size">
						{row.notionalUsd == null ? UNAVAILABLE : `~${formatSubvalueUsd(Number(row.notionalUsd))}`}
					</DetailRow>
				)}
				<DetailRow
					label="Token In"
					subValue={dollars != null ? formatSubvalueUsd(dollars.notionalIn) : undefined}
				>
					{formatTokenIn(row)}
				</DetailRow>
				<DetailRow
					label="Token Out"
					subValue={dollars != null ? formatSubvalueUsd(dollars.notionalOut) : undefined}
				>
					{formatTokenOut(row)}
				</DetailRow>
				{executionDelta != null && (
					<DetailRow label="Execution Delta" subValue={executionDelta.sub ?? undefined} stackOnMobile>
						{executionDelta.text}
					</DetailRow>
				)}

				{/* Gas is paid separately in ETH, outside the swap — it is not a price,
				    so it stays in the top block and does not enter Price Range below. */}
				<DetailRow label="Gas Cost" subValue="Paid separately in ETH">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</DetailRow>
			</div>

			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Price Range
			</h2>

			{/* Price Range is deliberately notional-free: every row here is a price,
			    not a dollar amount, on every tier. */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<DetailRow label="Execution Price">
					{row.realizedPrice == null
						? UNAVAILABLE
						: formatExecutionPrice(row.realizedPrice, base, quote)}
				</DetailRow>
				{/* Market Price + its methodology descriptor are ONE list item: the
				    footnote sits 20px under the row (Figma 656-4217), which
				    is why the row hugs and the wrapper owns the gap. The old
				    `*`-linkage is gone — position carries it now. */}
				<div className="flex flex-col gap-[20px]">
					{hasMarketPrice ? (
						<MarketPriceTable
							before={formatMidCell(row.marketMidBefore, base, quote)}
							at={formatMidCell(row.marketMid, base, quote)}
							after={formatMidCell(row.marketMidAfter, base, quote)}
						/>
					) : (
						<DetailRow label="Market Price" hug valueTooltip={NULL_PRICE_TOOLTIP}>
							N/A
						</DetailRow>
					)}
					{/* The badge is a sibling of the table, not part of the At Block cell:
					    that cell is a fixed 144px column already full of the price string
					    (Figma 647-3599), so the warning has nowhere to go inside it and
					    either wraps unreadably or overflows out of view. This wrapper
					    spans the full receipt column, so the badge gets its own line while
					    staying visually attached to the Market Price row. */}
					{hasMarketPrice && row.manipulationFlag ? (
						<p style={{ color: 'var(--color-yellow)' }}>
							<span title="Median pool mid deviates from the reference oracle by more than 0.5% at N-1">
								⚠ Possible manipulation
							</span>
						</p>
					) : null}
					{/* Renders on every tier — the unpriced tier's descriptor is the
					    "Unavailable: …" string, which the frames show under `N/A`. Each
					    of the three methodology phrases (if present) links to
					    /methodology in a new tab (Figma 546-694). The dispersion clause
					    appends only when all three blocks priced (priceDispersion.ts). */}
					<p className="text-[12px] leading-[20px] text-[var(--color-secondary)]">
						<MethodologyText text={methodologyText} />
						{dispersion ? ` ${dispersion}` : ''}
					</p>
				</div>

				{/*
				  Dropped entirely when there is no market price, rather than printing a
				  second "N/A" directly beneath the Market Price row that already says it.
				  Price Delta exists to state the gap per 1 base unit; with no mid there is
				  no gap to state, and the row adds a line of noise without a fact.
				*/}
				{priceDelta != null && (
					<DetailRow label="Price Delta" subValue={priceDelta.sub ?? undefined} stackOnMobile>
						{priceDelta.text}
					</DetailRow>
				)}
			</div>

			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Transaction Costs
			</h2>

			{/* Cost breakdown */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				{!routeReconstructed ? (
					<BkdHeading
						label="Third-Party Fee"
						value="N/A"
						tooltip={THIRD_PARTY_FEE_TOOLTIP}
						valueTooltip={NO_ROUTE_TOOLTIP}
						standalone
					/>
				) : hasAggFee ? (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Third-Party Fee" tooltip={THIRD_PARTY_FEE_TOOLTIP} />
						{feeLines.map((line, i) => {
							const d = formatDialogBps(-line.bps);
							return (
								<BkdRow
									key={`${line.href ?? line.label}-${i}`}
									label={line.label}
									href={line.href}
									value={d.text}
									color={d.color}
									secondary
								/>
							);
						})}
					</div>
				) : (
					<BkdHeading
						label="Third-Party Fee"
						value="0.00bps"
						tooltip={THIRD_PARTY_FEE_TOOLTIP}
						standalone
					/>
				)}

				{!routeReconstructed ? (
					/*
					  No route: one honest N/A, no leg list. The legs core emitted on this
					  path are not a route — a WETH9 wrap/unwrap pair that nets to nothing,
					  or a lone venue we never costed — and listing them under an "L.P.
					  Fee" heading would assert a breakdown we do not have. This replaces
					  the old "Pools Touched" fallback, which named the same rows without
					  claiming a fee and still implied we had followed the trade.
					*/
					<BkdHeading
						label="Liquidity Provider Fee"
						value="N/A"
						valueTooltip={NO_ROUTE_TOOLTIP}
						plain
						standalone
					/>
				) : legs.length === 0 ? (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Liquidity Provider Fee" plain />
						<BkdRow label="No Route Found" value="–" secondary />
					</div>
				) : (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Liquidity Provider Fee" plain />
						{legs.map((leg, index) => {
							// An unresolved tier outranks the numeric format: core fell
							// back to 0 bps without reading the pool, so "0.00bps" would
							// claim it was free rather than admit we could not read it.
							const unresolvedFee = hasUnresolvedFee(leg);
							const { text: lpText, color: lpColor } = isMakerLeg(leg) || unresolvedFee
								? { text: 'N/A', color: undefined }
								: leg.lpFeeBps == null
									? { text: '–', color: undefined }
									: formatDialogBps(-leg.lpFeeBps);
							return (
								<LegRow
									key={`${leg.venue}-${index}`}
									leg={leg}
									index={index}
									legsLength={legs.length}
									row={row}
									value={lpText}
									color={lpColor}
									valueTooltip={unresolvedFee ? UNRESOLVED_FEE_TOOLTIP : undefined}
								/>
							);
						})}
					</div>
				)}

				{!routeReconstructed ? (
					/*
					  Only ONE failure gates this section: with no route there is nothing to
					  measure impact ON.

					  ⚠️ `isPartial` deliberately does NOT gate it. Per-leg price impact is
					  measured against each leg's OWN pool mid at N-1 (decomposeRoute), so it
					  is entirely independent of the market ruler and survives a null
					  marketMid intact. The old gate's rationale — "there is a route but no
					  reference mid to measure it against" — is true of the WHOLE-TRADE delta
					  and false of a per-leg one; fusing them hid numbers we had measured.
					  The whole-trade rows below (Slippage, Positive Slippage, Total Execution
					  Delta) keep their `isPartial` gate, because those really are measured
					  against the ruler. Legs with no impact of their own still render N/A
					  individually via getPriceImpactRows.
					*/
					<BkdHeading
						label="Price Impact"
						value="N/A"
						valueTooltip={NO_ROUTE_TOOLTIP}
						tooltip="Per-venue delta between execution price and the prior-block mid, excluding third-party fees and L.P. fees"
						standalone
					/>
				) : (
					<div className={GROUP_SECTION}>
						<BkdHeading
							label="Price Impact"
							tooltip="Per-venue delta between execution price and the prior-block mid, excluding third-party fees and L.P. fees"
						/>
						{priceImpactRows.length > 0 ? (
							priceImpactRows.map((impact, index) => (
								<BkdRow
									key={`${impact.href ?? impact.label}-${index}`}
									label={impact.label}
									href={impact.href}
									context={legContext(impact.context, impact.router, false)}
									value={impact.value}
									color={impact.color}
									valueTooltip={impact.valueTooltip}
									secondary
								/>
							))
						) : (
							<BkdRow label="No Route Found" value="–" secondary />
						)}
					</div>
				)}

				<BkdHeading
					label="Slippage"
					value={execution.slippageDisplay.text}
					color={execution.slippageDisplay.color}
					tooltip="Residual cost after third-party fees, L.P. fees, and price impact"
					// On the partial tier the blocker is the missing reference mid, not
					// how much of the route we priced — a coverage percentage there
					// blames our leg readers for an absent market price.
					valueTooltip={isPartial ? NULL_PRICE_TOOLTIP : execution.slippageUnavailableTooltip}
					standalone
				/>
				{/*
				  Slippage splits into a cost half and a benefit half ONLY when we priced
				  every leg. The moment we could not, both halves are N/A and the signed
				  residual moves to Unattributed below — so a second N/A row would be pure
				  noise, restating the first row's "we could not calculate this" with a
				  different label. The split and Unattributed are mutually exclusive by
				  construction: both key off `fullyPriced`.
				*/}
				{execution.fullyPriced && (
					<BkdHeading
						label="Positive Slippage"
						value={execution.positiveSlippageDisplay.text}
						color={execution.positiveSlippageDisplay.color}
						tooltip="Residual benefit after third-party fees, L.P. fees, and price impact"
						valueTooltip={execution.slippageUnavailableTooltip}
						standalone
					/>
				)}
				{/*
				  Shown ONLY when a leg went unpriced. The residual is the same number the
				  Slippage row would have printed; what it is not is *slippage*, because we
				  never measured every leg's price impact. One signed row — it is not split
				  into cost/benefit halves the way Slippage is (Figma 577-1232).
				  On a route that never reconstructed this is the WHOLE execution delta,
				  because nothing at all was attributed — see getExecutionBreakdown.
				*/}
				{!execution.fullyPriced && execution.residualRawBps != null && (
					<BkdHeading
						label="Unattributed"
						value={execution.unattributedDisplay.text}
						color={execution.unattributedDisplay.color}
						tooltip={UNATTRIBUTED_TOOLTIP}
						standalone
					/>
				)}

				{/*
				  Renders on EVERY receipt that has a delta to state, including the
				  no-route one. It is computed from the market mid and the realized
				  price and has no per-leg dependency, so it must not sit behind a
				  leg-shaped gate — that is what hid it on this transaction.
				*/}
				<BkdRow
					label="Total Execution Delta"
					value={accuracy}
					color={accuracyColor}
					tooltip="Delta between execution price and market price; the sum of Third-Party Fee, L.P. Fee, Price Impact, and Slippage (or Unattributed)"
					standalone
				/>
			</div>

			{/* The rule above the share bar (Figma 546-793). */}
			<Divider />

			<div className="flex flex-col gap-[10px]">
				<ShareButton large />
			</div>
		</>
	);
}
