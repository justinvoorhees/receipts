'use client';
import { ReceiptSearch } from './receiptSearch';
import type { ReceiptRow } from '../lib/queries';
import type { AnalyzeFailure } from '@fabric-tca/core';
import { shortTxHash, formatGasUsd } from '../lib/formatters';
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
	beneficiaryAnchorNote,
	isUniswapXFillerRow,
	UNATTRIBUTED_TOOLTIP,
} from './receipt/receiptDisplay';
import { receiptDollars } from './receipt/qualityNotionals';
import type { PriceDeltaRow } from './receipt/priceFormat';
import {
	formatExecutionDelta,
	formatPriceDeltaUsd,
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
} from './receipt/receiptRows';

// A Cost Breakdown section (heading + its rows) gets 22px of extra bottom
// padding — but only when it actually has rows beneath the heading (Figma
// 546-713). A bare standalone heading (e.g. Aggregator Fee with no fee
// lines, or the unpriced Price Impact/Slippage pair) stays on the plain
// 20px rhythm and is never wrapped in this.
const GROUP_SECTION = 'flex flex-col gap-[20px] pb-[22px]';

export function ReceiptView({
	trade,
	hash,
	diagnosis,
}: {
	trade: ReceiptRow | null;
	hash: string;
	diagnosis?: AnalyzeFailure;
}) {
	// Only surface a failure when there is no receipt to show.
	const failure = trade === null ? diagnosis : undefined;

	return (
		<div className="flex flex-col gap-[40px]">
			<ReceiptSearch hash={hash} {...(failure ? { failure } : {})} />
			{/* The rule under the input renders in EVERY state, including the empty
			    page (Figma 544-2386) — which is why it lives here and not at the top
			    of <Receipt>, where the dialog would also inherit it. */}
			<Divider />
			{trade != null && <Receipt row={trade} />}
		</div>
	);
}

export function Receipt({
	row,
	sharePath,
	onClose,
	onDelete,
}: {
	row: ReceiptRow;
	sharePath?: string;
	onClose?: () => void;
	onDelete?: () => void;
}) {
	const legs = normalizeRouteLegs(row.routeLegs);
	const showFillerRow = isUniswapXFillerRow(row);
	const hasCostedLeg = legs.some((l) => typeof l.lpFeeBps === 'number');
	// Partial receipts have no reference mid, so price/impact/slippage are null.
	// Guard every numeric read against null instead of `Number(null) === 0`.
	const isPartial = row.pricingStatus === 'partial';
	// Market Price / Price Delta render whenever a mid exists (full OR estimated).
	const hasMarketPrice = row.marketMid != null;
	// The methodology descriptor renders as a footnote bound to the Market Price row
	// (positional, not a *-linkage) on every tier, including the unpriced one.
	// Rows persisted before the column was populated fall back to a tier-derived string.
	const methodologyText = row.methodology ?? fallbackMethodology(row.pricingStatus);
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const { text: accuracy, color: accuracyColor } = formatDialogBps(costBps == null ? null : -costBps);
	const feeLines = getAggregatorFeeLines(row);
	const hasAggFee = feeLines.length > 0;
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs, row);
	const pairTitle = receiptPairTitle(row);
	const { base, quote, baseIsOutput } = pairBaseQuote(row);
	// Single-ruler anchored state: receiptDollars is non-null iff a mid exists AND a
	// side anchors to USD (core address-based). Every anchored USD figure derives from
	// {notionalIn, notionalOut, execResultUsd} + the base (volatile) leg's amount.
	const dollars = receiptDollars(row);
	const anchored = dollars != null;
	const baseAmount = Number(baseIsOutput ? row.outputAmount : row.inputAmount);
	const execUsdPerBase = dollars != null && baseAmount > 0 ? dollars.notionalIn / baseAmount : null;
	const marketUsdPerBase = dollars != null && baseAmount > 0 ? dollars.notionalOut / baseAmount : null;
	const deltaUsdPerBase = dollars != null && baseAmount > 0 ? Math.abs(dollars.execResultUsd) / baseAmount : null;
	// Execution Delta states the gap on THIS trade; Price Delta states it per 1 base.
	// Same sentence, same direction source — they can never disagree.
	const executionDelta =
		dollars != null
			? formatExecutionDelta(dollars.execResultUsd, base, baseIsOutput, formatTokenIn(row))
			: null;
	// Price Delta takes ONE sentence shape everywhere; only the denomination differs.
	// An anchored pair states the gap in USD (from the same execResultUsd the
	// Execution Delta row uses); everything else states it in the quote token,
	// since the stored mid/realized are already quote-per-base. Direction lives
	// in the text now, so neither path carries a tooltip.
	const priceDelta: PriceDeltaRow | null = !hasMarketPrice
		? null
		: dollars != null && deltaUsdPerBase != null
			? formatPriceDeltaUsd(deltaUsdPerBase, base, baseIsOutput, dollars.execResultUsd)
			: formatPriceDeltaToken(row.marketMid, row.realizedPrice, base, quote, baseIsOutput);

	return (
		<>
			<div className="flex items-center justify-between">
				<h2 className="w-fit">
					<a
						href={`https://basescan.org/tx/${row.txHash}`}
						target="_blank"
						rel="noreferrer"
						className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						{shortTxHash(row.txHash)}
					</a>
				</h2>
				{onClose != null && (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close transaction details"
						className="flex h-[40px] w-[40px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] p-[8px] text-[var(--color-primary)] transition-colors hover:bg-[var(--color-surface-low)] active:bg-[var(--color-surface-low)]"
					>
						<span aria-hidden="true" className="relative block h-[18px] w-[18px]">
							<span className="absolute left-1/2 top-0 h-[18px] w-[2px] -translate-x-1/2 rotate-45 bg-current" />
							<span className="absolute left-1/2 top-0 h-[18px] w-[2px] -translate-x-1/2 -rotate-45 bg-current" />
						</span>
					</button>
				)}
			</div>

			{/* Detail table */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				{showFillerRow ? (
					<FillerRow address={row.fillerAddress as string} />
				) : (
					<DetailRow label="Aggregator">
						<AggregatorValue row={row} />
					</DetailRow>
				)}
				{!showFillerRow && beneficiaryAnchorNote(row) && (
					<p className="text-[var(--color-secondary)]">{beneficiaryAnchorNote(row)}</p>
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
					<DetailRow label="Execution Delta" subValue={executionDelta.sub ?? undefined}>
						{executionDelta.text}
					</DetailRow>
				)}

				<DetailRow
					label="Execution Price"
					subValue={execUsdPerBase != null ? formatSubvalueUsd(execUsdPerBase) : undefined}
				>
					{row.realizedPrice == null
						? UNAVAILABLE
						: formatExecutionPrice(row.realizedPrice, base, quote)}
				</DetailRow>
				{/* Market Price + its methodology descriptor are ONE list item: the
				    footnote sits 10px under the row (Figma 546-687 / 549-3112), which
				    is why the row hugs and the wrapper owns the gap. The old
				    `*`-linkage is gone — position carries it now. */}
				<div className="flex flex-col gap-[10px]">
					<DetailRow
						label="Market Price"
						hug
						subValue={marketUsdPerBase != null ? formatSubvalueUsd(marketUsdPerBase) : undefined}
						{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
					>
						{hasMarketPrice ? formatExecutionPrice(row.marketMid, base, quote) : 'N/A'}
						{hasMarketPrice && row.manipulationFlag ? (
							<span
								className="ml-2"
								style={{ color: 'var(--color-yellow)' }}
								title="Median pool mid deviates from the reference oracle by more than 0.5% at N-1"
							>
								⚠ Possible manipulation
							</span>
						) : null}
					</DetailRow>
					{/* Renders on every tier — the unpriced tier's descriptor is the
					    "Unavailable: …" string, which the frames show under `N/A`. Each
					    of the three methodology phrases (if present) links to
					    /methodology in a new tab (Figma 546-694). */}
					<p className="text-[10px] leading-[16px] text-[var(--color-secondary)]">
						<MethodologyText text={methodologyText} />
					</p>
				</div>

				<DetailRow
					label="Price Delta"
					subValue={priceDelta?.sub ?? undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
					{priceDelta?.text ?? 'N/A'}
				</DetailRow>

				{/* The descriptor is a property of the row, not of the number: gas is paid
				    in ETH outside the swap regardless of whether we could price it. */}
				<DetailRow label="Gas Cost" subValue="Paid separately in ETH">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</DetailRow>
			</div>

			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Cost Breakdown
			</h2>

			{/* Cost breakdown */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				{hasAggFee ? (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Aggregator Fee" plain />
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
					<BkdHeading label="Aggregator Fee" value="0.00bps" plain standalone />
				)}

				{legs.length === 0 ? (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Liquidity Provider Fee" plain />
						<BkdRow label="No Route Found" value="–" secondary />
					</div>
				) : hasCostedLeg ? (
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
				) : (
					<div className={GROUP_SECTION}>
						<BkdHeading label="Pools Touched" plain />
						{legs.map((leg, index) => (
							<LegRow
								key={`${leg.venue}-${index}`}
								leg={leg}
								index={index}
								legsLength={legs.length}
								row={row}
								value="–"
								requirePair
							/>
						))}
					</div>
				)}

				{isPartial || (legs.length > 0 && !hasCostedLeg) ? (
					<>
						<BkdHeading
							label="Price Impact"
							value="N/A"
							valueTooltip={NULL_PRICE_TOOLTIP}
							tooltip="Per-venue delta between execution price and the prior-block mid, excluding L.P. fee"
							standalone
						/>
						<BkdHeading
							label="Slippage"
							value="N/A"
							valueTooltip={NULL_PRICE_TOOLTIP}
							tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
							standalone
						/>
					</>
				) : (
					<>
						<div className={GROUP_SECTION}>
							<BkdHeading
								label="Price Impact"
								tooltip="Per-venue delta between execution price and the prior-block mid, excluding L.P. fee"
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

						<BkdHeading
							label="Slippage"
							value={execution.slippageDisplay.text}
							color={execution.slippageDisplay.color}
							tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
							valueTooltip={
								execution.slippageUnavailableTooltip
							}
							standalone
						/>
						<BkdHeading
							label="Positive Slippage"
							value={execution.positiveSlippageDisplay.text}
							color={execution.positiveSlippageDisplay.color}
							tooltip="Residual benefit after L.P. fees, aggregator fees, and price impact"
							valueTooltip={
								execution.slippageUnavailableTooltip
							}
							standalone
						/>
						{/*
						  Shown ONLY when a leg went unpriced. The residual is the same number the
						  Slippage row would have printed; what it is not is *slippage*, because we
						  never measured every leg's price impact. One signed row — it is not split
						  into cost/benefit halves the way Slippage is (Figma 577-1232).
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

						<BkdRow
							label="Total Execution Delta"
							value={accuracy}
							color={accuracyColor}
							tooltip="Delta between execution price and market price; the sum of L.P. Fee, Aggregator Fee, Price Impact, and Slippage (or Unattributed)"
							standalone
						/>
					</>
				)}
			</div>

			{/* The rule above the share bar (Figma 546-793) belongs to the standalone
			    page only — the dialog's button area is deliberately unchanged. */}
			{onClose == null && <Divider />}

			<div className="flex flex-col gap-[10px]">
				{onDelete != null && (
					<button
						type="button"
						onClick={onDelete}
						className="flex h-[40px] w-full shrink-0 cursor-pointer items-center justify-center bg-[var(--color-quaternary)] px-[20px] font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] text-[var(--color-white)]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						Delete
					</button>
				)}
				<ShareButton large={onClose == null} {...(sharePath !== undefined ? { path: sharePath } : {})} />
			</div>
		</>
	);
}
