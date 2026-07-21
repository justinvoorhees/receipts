'use client';
import { ReceiptSearch } from './ReceiptSearch';
import type { ReceiptRow, RouteLeg } from '../lib/queries';
import type { AnalyzeFailure } from '@fabric-tca/core';
import {
	formatProvider,
	providerColor,
	shortTxHash,
	formatGasUsd,
} from '../lib/formatters';
import {
	formatDialogBps,
	formatExecutionPrice,
	formatPriceMagnitude,
	formatSubvalueUsd,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	legPairContext,
	getExecutionBreakdown,
	getPriceImpactRows,
	getStepContext,
	getVenueLabel,
	getAggregatorFeeAttribution,
	ShareButton,
	RFQ_LEG_TOOLTIP,
	isMakerLeg,
	NULL_PRICE_TOOLTIP,
	beneficiaryAnchorNote,
	isUniswapXFillerRow,
} from './TradesTable';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './receipt/symbols';
import { receiptDollars, formatExecutionResult } from './receipt/qualityNotionals';

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
 * (packages/core/src/pricing.ts) at tier granularity — the stored string is richer
 * (it names the corroborating estimators) and always wins when present.
 */
export function fallbackMethodology(pricingStatus: string): string {
	if (pricingStatus === 'full') return 'Corroborated market price at block N-1.';
	if (pricingStatus === 'estimated') return 'Estimated: uncorroborated pool mid at block N-1.';
	return 'No reliable market price available.';
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
function receiptPairTitle(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): string {
	return `${row.inputSymbol} → ${row.outputSymbol}`;
}

const NAMED_CHAINS: Record<number, string> = {
	1: 'Ethereum',
	10: 'Optimism',
	137: 'Polygon',
	8453: 'Base',
	42161: 'Arbitrum',
};

function chainLabel(chainId: number): string {
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
function pairBaseQuote(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): {
	base: string;
	quote: string;
	baseIsOutput: boolean;
} {
	const baseIsOutput = symbolAnchorRank(row.outputSymbol) < symbolAnchorRank(row.inputSymbol);
	return baseIsOutput
		? { base: row.outputSymbol, quote: row.inputSymbol, baseIsOutput }
		: { base: row.inputSymbol, quote: row.outputSymbol, baseIsOutput };
}

const UNAVAILABLE = 'Unavailable for this pair';

function Divider({ dashed = false, color }: { dashed?: boolean; color?: string }) {
	if (dashed) {
		return (
			<div
				className="h-px w-full shrink-0"
				style={{
					backgroundImage:
						'repeating-linear-gradient(to right, var(--color-border) 0, var(--color-border) 1px, transparent 1px, transparent 3px)',
				}}
			/>
		);
	}
	return <div className="h-px w-full shrink-0 bg-[var(--color-primary)]" style={color ? { backgroundColor: `var(--color-${color})` } : undefined} />;
}

function DetailRow({
	label,
	children,
	underscored = false,
	tooltip,
	valueTooltip,
	subLabel,
	subValue,
	subValueColor,
	valueColor,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	tooltip?: string;
	valueTooltip?: string;
	/** Muted second line under the label (e.g. the Market Price methodology string). */
	subLabel?: React.ReactNode;
	/** Second line under the value (e.g. a USD subvalue, or Gained/Lost). */
	subValue?: React.ReactNode;
	/** Overrides the subvalue color; defaults to secondary. */
	subValueColor?: string | undefined;
	/**
	 * Colors the VALUE itself (e.g. green on a Spread gain). Direction belongs on the
	 * number, not on the muted descriptor beneath it — so the subvalue stays secondary
	 * gray and this carries the signal. Losses pass undefined: the app colors gains
	 * green and leaves everything else primary (see formatDialogBps).
	 */
	valueColor?: string | undefined;
}) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			<div className="flex flex-col gap-[10px]">
				{tooltip ? (
					<span className="group relative cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
						{label}
						<div
							role="tooltip"
							className="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{tooltip}
						</div>
					</span>
				) : (
					<span
						className={`text-[var(--color-primary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
					>
						{label}
					</span>
				)}
				{subLabel != null && (
					<span className="text-[12px] leading-[12px] text-[var(--color-secondary)]">{subLabel}</span>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-[10px]">
				{valueTooltip ? (
					<span className="min-w-0 text-right" style={valueColor ? { color: valueColor } : undefined}>
						<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid">
							{children}
							<div
								role="tooltip"
								className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
							>
								{valueTooltip}
							</div>
						</span>
					</span>
				) : (
					<span className="min-w-0 text-right" style={valueColor ? { color: valueColor } : undefined}>
						{children}
					</span>
				)}
				{subValue != null && (
					<span
						className="text-[12px] leading-[12px] text-right"
						style={{ color: subValueColor ?? 'var(--color-secondary)' }}
					>
						{subValue}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * Aggregator detail value: the provider name (or the full router address when
 * unattributed), linked to the router contract's Basescan page. The linked
 * address is the contract this trade actually called (`routerAddress` = tx.to,
 * persisted by core) — never a slug→address guess, since one aggregator can
 * run several routers (Odos V2/V3, 0x's per-deploy Settlers). Rows persisted
 * before `routerAddress` existed fall back to the slug when it IS the address
 * (unattributed aggregators); otherwise the name renders unlinked.
 */
function AggregatorValue({ row }: { row: ReceiptRow }) {
	const slug = row.aggregator.toLowerCase();
	const address = row.routerAddress ?? (slug.startsWith('0x') && slug.length > 10 ? slug : null);
	const label = (
		<span className="break-all" style={{ color: providerColor(slug) }}>
			{formatProvider(slug, { full: true })}
		</span>
	);
	if (!address) return label;
	return (
		<a
			href={`https://basescan.org/address/${address}`}
			target="_blank"
			rel="noreferrer"
			className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
			style={{ textDecorationColor: providerColor(slug) }}
		>
			{label}
		</a>
	);
}

/**
 * Filler detail row: replaces the Aggregator row for UniswapX-anchored
 * trades — there is no aggregator here, only the filler who submitted the
 * fill on the swapper's behalf. Two-line label (Filler / via UniswapX),
 * same grid shell as DetailRow so it lines up with every other row.
 */
function FillerRow({ address }: { address: string }) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			<div className="flex flex-col gap-[10px]">
				<span className="text-[var(--color-primary)]">Filler</span>
				<span className="text-[var(--color-secondary)]">via UniswapX</span>
			</div>
			<span className="min-w-0 text-right">
				<a
					href={`https://basescan.org/address/${address}`}
					target="_blank"
					rel="noreferrer"
					className="break-all text-[var(--color-primary)] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
				>
					{address}
				</a>
			</span>
		</div>
	);
}

function BkdHeading({
	label,
	value,
	color,
	tooltip,
	valueTooltip,
	plain = false,
}: {
	label: string;
	value?: string | undefined;
	color?: string | undefined;
	tooltip?: string | undefined;
	valueTooltip?: string | undefined;
	plain?: boolean;
}) {
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			{tooltip ? (
				<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
					{label}
					<div
						role="tooltip"
						className="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
					>
						{tooltip}
					</div>
				</span>
			) : (
				<span className={plain ? '' : 'underline decoration-dotted underline-offset-[3px]'}>{label}</span>
			)}
			{value != null && (
				valueTooltip ? (
					<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
						<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
						<span
							role="tooltip"
							className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{valueTooltip}
						</span>
					</span>
				) : (
					<span className="text-right" style={color ? { color } : undefined}>
						{value}
					</span>
				)
			)}
		</div>
	);
}

function BkdRow({
	label,
	value,
	context,
	href,
	color,
	labelColor,
	valueTooltip,
	tooltip,
	secondary = false,
	plain = false,
}: {
	label: string;
	value: string;
	context?: string | undefined;
	href?: string | undefined;
	color?: string | undefined;
	labelColor?: string | undefined;
	valueTooltip?: string | undefined;
	tooltip?: string | undefined;
	secondary?: boolean;
	plain?: boolean;
}) {
	const labelClass = [
		plain ? '' : 'underline decoration-dotted underline-offset-[3px]',
		secondary ? 'text-[var(--color-secondary)]' : '',
	]
		.filter(Boolean)
		.join(' ');
	const labelStyle = labelColor ? { color: labelColor } : undefined;
	const labelNode = href ? (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`${labelClass} hover:decoration-solid`}
			style={labelStyle}
		>
			{label}
		</a>
	) : (
		<span className={labelClass} style={labelStyle}>
			{label}
		</span>
	);
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			<div className="min-w-0">
				{tooltip ? (
					<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
						{label}
						<div
							role="tooltip"
							className="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{tooltip}
						</div>
					</span>
				) : (
					labelNode
				)}
				{context != null && (
					<span className="ml-[10px] text-[var(--color-quaternary)]">{context}</span>
				)}
			</div>
			{valueTooltip ? (
				<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
					<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
					<span
						role="tooltip"
						className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
					>
						{valueTooltip}
					</span>
				</span>
			) : (
				<span className="text-right" style={color ? { color } : undefined}>
					{value}
				</span>
			)}
		</div>
	);
}

// Shared row for the Cost Breakdown "Liquidity Provider Fee" / "Pools Touched"
// lists — same venue/label/context, differing only in the value column and
// (for the uncosted "Pools Touched" list) an extra guard against legs missing
// a token pair.
function LegRow({
	leg,
	index,
	legsLength,
	row,
	value,
	color,
	requirePair = false,
}: {
	leg: RouteLeg;
	index: number;
	legsLength: number;
	row: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>;
	value: string;
	color?: string | undefined;
	requirePair?: boolean;
}) {
	const stepContext = getStepContext(leg.type);
	const isStep = stepContext != null;
	const hasPair = leg.tokenIn && leg.tokenOut;
	const hideContext = requirePair && !isStep && !hasPair;
	const maker = isMakerLeg(leg);
	return (
		<BkdRow
			label={getVenueLabel(leg)}
			href={`https://basescan.org/address/${leg.venue}`}
			context={stepContext ?? (hideContext ? undefined : legPairContext(leg, index, legsLength, row))}
			value={value}
			color={color}
			secondary
			{...(maker ? { labelColor: 'var(--color-secondary)', valueTooltip: RFQ_LEG_TOOLTIP } : {})}
		/>
	);
}

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
					label="Market Price"
					subLabel={methodologyText}
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
						<BkdHeading label="Price Impact" value="Null" valueTooltip={NULL_PRICE_TOOLTIP} plain />
						<BkdHeading label="Slippage" value="Null" valueTooltip={NULL_PRICE_TOOLTIP} plain />
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
