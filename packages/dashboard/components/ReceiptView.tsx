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
	formatUsdMagnitude,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	legPairContext,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
	ShareButton,
	STABLE_SYMBOLS,
} from './TradesTable';

/**
 * Price Delta value: the gap between the market mid and the executed rate, in
 * the pair's quote token — the same quote-per-base convention the Execution and
 * Market Price rows above it use, formatted by the same rule. Unsigned; the
 * tooltip carries the verdict. Computed from the STORED values, not the rounded
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

/**
 * Was the fill better or worse than the mid? Direction-aware, and that is the
 * whole point: prices are quote-per-BASE, so a lower price is better only when
 * the user is BUYING the base (baseIsOutput). When the base is the input the
 * user is selling it and a higher price is better. Reading the sign without the
 * direction inverts the verdict on every buy — the bug this replaces.
 *
 * Reads the raw stored mid/realized in every case (USD-anchored, ETH-quoted, and
 * no-anchor alike): the display rescale that used to be applied is strictly
 * positive (marketUsd − execUsd = execUsd·(mm−rp)/rp, with execUsd > 0, rp > 0),
 * so it can never flip the sign. Null on an exact tie — matching formatPriceDelta's
 * "None", so the value and the tooltip can never disagree.
 */
export function priceDeltaVerdict(
	marketMid: unknown,
	realizedPrice: unknown,
	baseIsOutput: boolean,
): 'better' | 'worse' | null {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return null;
	if (exec === mid) return null;
	const better = baseIsOutput ? exec < mid : exec > mid;
	return better ? 'better' : 'worse';
}

/**
 * The base is always the bought token on a buy and the sold token on a sell —
 * that is what baseIsOutput means — so one flag picks both the token and the
 * verb. Naming the base is also what makes the tooltip describe the number on
 * screen, since Execution and Market Price are both quoted per base token.
 */
export function priceDeltaTooltip(base: string, baseIsOutput: boolean, verdict: 'better' | 'worse'): string {
	return `${base} was ${baseIsOutput ? 'bought' : 'sold'} at ${verdict} than Market Price`;
}

// The title reads as the swap direction — inputSymbol→outputSymbol — so it
// always matches the Token In / Token Out rows below it (USDC→WETH shows
// "USDC→WETH", WARP→ETH shows "WARP→ETH"). Price rows are separately quoted
// USD-per-base and are unaffected by this ordering. input/output are populated
// consistently for seed and computed rows, so we never parse `direction`.
function receiptPairTitle(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): string {
	return `${row.inputSymbol}→${row.outputSymbol}`;
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

const ETH_SYMBOLS = new Set(['WETH', 'ETH']);

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

/**
 * For an ETH/WETH-quoted pair (one leg is WETH/native ETH, neither leg a
 * stablecoin), the stored realizedPrice/marketMid are ETH-per-base, not USD.
 * Re-express the price rows in USD-per-base from stored fields. Returns null for
 * stablecoin-quoted or unpriceable receipts (caller keeps the existing path).
 */
function usdPerBasePrices(row: Pick<ReceiptRow,
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

// A token independently anchors to USD when it's a stablecoin (≈ $1) or ETH/WETH
// (priced via the benchmark mid). Tier-independent — it says the pair *has* a USD
// tie-point, not that any particular mid is trustworthy.
export function isAnchorable(symbol: string): boolean {
	return STABLE_SYMBOLS.has(symbol) || ETH_SYMBOLS.has(symbol);
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
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	tooltip?: string;
	valueTooltip?: string;
}) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
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
			{valueTooltip ? (
				<span className="min-w-0 text-right">
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
				<span className="min-w-0 text-right">{children}</span>
			)}
		</div>
	);
}

function BkdHeading({
	label,
	value,
	color,
	tooltip,
	plain = false,
}: {
	label: string;
	value?: string | undefined;
	color?: string | undefined;
	tooltip?: string | undefined;
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
				<span className="text-right" style={color ? { color } : undefined}>
					{value}
				</span>
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
	const labelNode = href ? (
		<a href={href} target="_blank" rel="noreferrer" className={`${labelClass} hover:decoration-solid`}>
			{label}
		</a>
	) : (
		<span className={labelClass}>{label}</span>
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
						className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-[280px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
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
	const isStep = leg.type === 'wrap' || leg.type === 'unwrap';
	const hasPair = leg.tokenIn && leg.tokenOut;
	const hideContext = requirePair ? isStep || !hasPair : isStep;
	return (
		<BkdRow
			label={getVenueLabel(leg)}
			href={`https://basescan.org/address/${leg.venue}`}
			context={hideContext ? undefined : legPairContext(leg, index, legsLength, row)}
			value={value}
			color={color}
			secondary
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
	const hasCostedLeg = legs.some((l) => typeof l.lpFeeBps === 'number');
	// Partial receipts have no reference mid, so price/impact/slippage are null.
	// Guard every numeric read against null instead of `Number(null) === 0`.
	const isPartial = row.pricingStatus === 'partial';
	const isEstimated = row.pricingStatus === 'estimated';
	// Market Price / Price Delta render whenever a mid exists (full OR estimated).
	const hasMarketPrice = row.marketMid != null;
	const marketTooltip = isEstimated
		? 'Best-effort reference from the deepest on-chain pool at block N-1; not oracle-validated.'
		: 'Median of the traded pair’s reference pools at the trade’s block, cross-referenced against an on-chain price oracle';
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const { text: accuracy, color: accuracyColor } = formatDialogBps(costBps == null ? null : -costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const aggAttribution = getAggregatorFeeAttribution(row);
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs, row);
	const pairTitle = receiptPairTitle(row);
	const { base, quote, baseIsOutput } = pairBaseQuote(row);
	// Price Delta is quote-denominated in every case — anchored, ETH-quoted, and
	// no-anchor memecoin alike — because the stored mid/realized are already
	// quote-per-base. No USD, no tiers, one path.
	const priceDeltaText = hasMarketPrice
		? formatPriceDelta(row.marketMid, row.realizedPrice, quote)
		: undefined;
	const verdict = hasMarketPrice ? priceDeltaVerdict(row.marketMid, row.realizedPrice, baseIsOutput) : null;
	const priceDeltaTip = verdict ? priceDeltaTooltip(base, baseIsOutput, verdict) : undefined;

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
				<DetailRow label="Aggregator">
					<span style={{ color: providerColor(row.aggregator.toLowerCase()) }}>
						{formatProvider(row.aggregator.toLowerCase())}
					</span>
				</DetailRow>
				<DetailRow label="Pair">{pairTitle}</DetailRow>
				<DetailRow label="Chain">{chainLabel(row.chainId)}</DetailRow>
				<DetailRow label="Block">{row.blockNumber.toLocaleString()}</DetailRow>

				<Divider dashed />

				{/* Trade size at a glance. Deliberately soft — it claims nothing, and is
				    the only USD figure in this block. notionalUsd already prefers the
				    USD-anchored side (pricing.ts bestEffortNotional), which is why we use
				    it as-is rather than re-deriving the input side. */}
				<DetailRow label="Size">
					{row.notionalUsd == null ? UNAVAILABLE : formatSubvalueUsd(Number(row.notionalUsd))}
				</DetailRow>
				<DetailRow label="Token In">{formatTokenIn(row)}</DetailRow>
				<DetailRow label="Token Out">{formatTokenOut(row)}</DetailRow>

				<Divider dashed />

				<DetailRow label="Execution Price">
					{row.realizedPrice == null
						? UNAVAILABLE
						: formatExecutionPrice(row.realizedPrice, base, quote)}
				</DetailRow>
				<DetailRow label="Market Price" tooltip={marketTooltip}>
					{hasMarketPrice
						? formatExecutionPrice(row.marketMid, base, quote)
						: UNAVAILABLE}
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
					{...(priceDeltaTip ? { valueTooltip: priceDeltaTip } : {})}
				>
					{hasMarketPrice ? priceDeltaText : UNAVAILABLE}
				</DetailRow>

				<Divider dashed />

				<DetailRow label="Gas Cost">
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
							const { text: lpText, color: lpColor } =
								leg.lpFeeBps == null ? { text: '–', color: undefined } : formatDialogBps(-leg.lpFeeBps);
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
							tooltip={aggAttribution.tooltip}
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
					<BkdHeading label={`Price Impact / Slippage ${UNAVAILABLE.toLowerCase()}`} plain />
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
