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
	getAggregatorFeeAttribution,
	ShareButton,
	isMakerLeg,
	NULL_PRICE_TOOLTIP,
	beneficiaryAnchorNote,
	isUniswapXFillerRow,
} from './receipt/receiptDisplay';
import { receiptDollars, formatExecutionResult } from './receipt/qualityNotionals';
import type { PriceDeltaRow } from './receipt/priceFormat';
import {
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
} from './receipt/receiptRows';

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
		<div className="flex flex-col gap-[40px] pb-10">
			<ReceiptSearch hash={hash} {...(failure ? { failure } : {})} />
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
	// The methodology descriptor replaces what used to be a hardcoded tooltip: it is
	// on-screen for every tier, including the null one. Rows persisted before the
	// column was populated (all of them, today) fall back to a tier-derived string.
	const methodologyText = row.methodology ?? fallbackMethodology(row.pricingStatus);
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const { text: accuracy, color: accuracyColor } = formatDialogBps(costBps == null ? null : -costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const aggAttribution = getAggregatorFeeAttribution(row);
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
	const execResult = dollars != null ? formatExecutionResult(dollars.execResultUsd) : null;
	// Price Delta takes ONE sentence shape everywhere; only the denomination differs.
	// An anchored pair states the gap in USD (from the same execResultUsd the Spread
	// row uses); everything else states it in the quote token, since the stored
	// mid/realized are already quote-per-base. Direction lives in the text now, so
	// neither path carries a tooltip.
	const priceDelta: PriceDeltaRow | null = !hasMarketPrice
		? null
		: dollars != null && deltaUsdPerBase != null
			? formatPriceDeltaUsd(deltaUsdPerBase, base, baseIsOutput, dollars.execResultUsd)
			: formatPriceDeltaToken(row.marketMid, row.realizedPrice, base, quote, baseIsOutput);

	return (
		<>
			{onClose == null && <Divider color="primary" />}

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

				<Divider dashed />

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
				{execResult != null && (
					<DetailRow label="Spread" subValue={execResult.sub} valueColor={execResult.color}>
						{execResult.text}
					</DetailRow>
				)}

				<Divider dashed />

				<DetailRow
					label="Execution Price"
					subValue={execUsdPerBase != null ? formatSubvalueUsd(execUsdPerBase) : undefined}
				>
					{row.realizedPrice == null
						? UNAVAILABLE
						: formatExecutionPrice(row.realizedPrice, base, quote)}
				</DetailRow>
				<DetailRow
					label={hasMarketPrice ? 'Market Price*' : 'Market Price'}
					subValue={marketUsdPerBase != null ? formatSubvalueUsd(marketUsdPerBase) : undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
					{hasMarketPrice
						? formatExecutionPrice(row.marketMid, base, quote)
						: 'Null'}
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
				<DetailRow
					label="Price Delta"
					subValue={priceDelta?.sub ?? undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
					{priceDelta?.text ?? 'Null'}
				</DetailRow>

				{hasMarketPrice && (
					<p className="text-[12px] leading-[18px] text-[var(--color-secondary)]">
						*{methodologyText}
					</p>
				)}

				<Divider dashed />

				{/* The descriptor is a property of the row, not of the number: gas is paid
				    in ETH outside the swap regardless of whether we could price it. */}
				<DetailRow label="Gas Cost" subValue="Paid separately in ETH">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</DetailRow>
			</div>

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Cost Breakdown
			</h2>

			{/* Cost breakdown */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				{legs.length === 0 ? (
					<>
						<BkdHeading label="Liquidity Provider Fee" plain />
						<BkdRow label="No Route Found" value="–" secondary />
					</>
				) : hasCostedLeg ? (
					<>
						<BkdHeading label="Liquidity Provider Fee" plain />
						{legs.map((leg, index) => {
							const { text: lpText, color: lpColor } = isMakerLeg(leg)
								? { text: 'Null', color: undefined }
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
								/>
							);
						})}
					</>
				) : (
					<>
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
					</>
				)}

				<Divider dashed />

				{hasAggFee ? (
					<>
						<BkdHeading label="Aggregator Fee" plain />
						<BkdRow
							label={aggAttribution.label}
							href={aggAttribution.href}
							value={agg.text}
							color={agg.color}
							secondary
						/>
					</>
				) : (
					<BkdHeading label="Aggregator Fee" value="0.00bps" plain />
				)}

				<Divider dashed />

				{isPartial || (legs.length > 0 && !hasCostedLeg) ? (
					<>
						<BkdHeading
							label="Price Impact"
							value="Null"
							valueTooltip={NULL_PRICE_TOOLTIP}
							tooltip="Per-venue delta between execution price and the prior-block mid, excluding L.P. fee"
						/>
						<BkdHeading
							label="Slippage"
							value="Null"
							valueTooltip={NULL_PRICE_TOOLTIP}
							tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
						/>
					</>
				) : (
					<>
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
									context={impact.context}
									value={impact.value}
									color={impact.color}
									valueTooltip={impact.valueTooltip}
									secondary
								/>
							))
						) : (
							<BkdRow label="No Route Found" value="–" secondary />
						)}

						<Divider dashed />

						<BkdHeading
							label="Slippage"
							value={execution.slippageDisplay.text}
							color={execution.slippageDisplay.color}
							tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
						/>
						<BkdHeading
							label="Positive Slippage"
							value={execution.positiveSlippageDisplay.text}
							color={execution.positiveSlippageDisplay.color}
							tooltip="Residual benefit after L.P. fees, aggregator fees, and price impact"
						/>

						<Divider dashed />
						<BkdRow
							label="Total Execution Quality"
							value={accuracy}
							color={accuracyColor}
							tooltip="Delta between execution price and market price; the sum of L.P. Fee, Aggregator Fee, Price Impact, and Slippage"
						/>
					</>
				)}
			</div>

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
				<ShareButton {...(sharePath !== undefined ? { path: sharePath } : {})} />
			</div>
		</>
	);
}
