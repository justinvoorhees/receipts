'use client';
import { ReceiptSearch } from './ReceiptSearch';
import type { ReceiptRow } from '../lib/queries';
import {
	formatProvider,
	providerColor,
	shortTxHash,
	formatGasUsd,
} from '../lib/formatters';
import {
	formatDialogBps,
	formatExecutionPrice,
	formatSubvalueUsd,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	tokenSymbol,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
	executionGrade,
	executionGradeTooltip,
	ShareButton,
} from './TradesTable';

export function formatDelta(marketMid: unknown, realizedPrice: unknown): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	return `$${Math.abs(mid - exec).toFixed(2)}`;
}

export function priceDeltaComparison(marketMid: unknown, realizedPrice: unknown): string | undefined {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return undefined;
	if (Math.abs(exec - mid) < 0.01) return 'At Market';
	if (exec > mid) return 'Below Market';
	return 'Above Market';
}

// Pricing convention: quote token first, e.g. a USDC→WETH swap (input USDC,
// output WETH) shows "WETH→USDC" — i.e. outputSymbol→inputSymbol. Populated
// consistently for seed and computed rows, so we never parse `direction`.
function receiptPairTitle(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): string {
	return `${row.outputSymbol}→${row.inputSymbol}`;
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

// Price rows are quoted as "<price> = 1 <base>". The base is the non-notional
// leg — the side whose amount × realizedPrice reconstructs the USD notional
// (WETH for USDC/WETH, in either direction). Falls back to the output token.
function priceUnitSymbol(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'realizedPrice' | 'notionalUsd'>): string {
	const rp = row.realizedPrice == null ? null : Number(row.realizedPrice);
	const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
	if (rp != null && notional != null && Number.isFinite(rp) && Number.isFinite(notional) && rp > 0) {
		const outDelta = Math.abs(Number(row.outputAmount) * rp - notional);
		const inDelta = Math.abs(Number(row.inputAmount) * rp - notional);
		return inDelta < outDelta ? row.inputSymbol : row.outputSymbol;
	}
	return row.outputSymbol;
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
	subvalue,
	tooltip,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	subvalue?: string | undefined;
	tooltip?: string;
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
			{subvalue != null ? (
				<div className="flex flex-col gap-[10px] items-end min-w-0">
					<span>{children}</span>
					<span className="text-[var(--color-secondary)]">{subvalue}</span>
				</div>
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

export function ReceiptView({ trade, hash }: { trade: ReceiptRow | null; hash: string }) {
	const error = trade === null ? 'Transaction not found.' : undefined;

	return (
		<div className="flex flex-col gap-[40px] pb-10">
			<ReceiptSearch hash={hash} {...(error !== undefined ? { error } : {})} />

			{trade != null && <Receipt row={trade} />}
		</div>
	);
}

export function Receipt({ row, sharePath }: { row: ReceiptRow; sharePath?: string }) {
	const legs = normalizeRouteLegs(row.routeLegs);
	// Partial receipts have no reference mid, so price/impact/slippage are null.
	// Guard every numeric read against null instead of `Number(null) === 0`.
	const isPartial = row.pricingStatus === 'partial';
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const { text: accuracy, color: accuracyColor } = formatDialogBps(costBps == null ? null : -costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs);
	const pairTitle = receiptPairTitle(row);
	const priceUnit = priceUnitSymbol(row);
	const notionalSubvalue = formatSubvalueUsd(row.notionalUsd != null ? Number(row.notionalUsd) : NaN);

	return (
		<>
			<Divider color="primary" />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[30px] leading-[30px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				{shortTxHash(row.txHash)}
			</h2>

			<div className="flex items-center justify-between">
				<h2
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					{pairTitle}
				</h2>
				{isPartial || costBps == null ? (
					<span
						className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] text-[var(--color-secondary)]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						N/A
					</span>
				) : (
					<span
						className="group relative cursor-default font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						{executionGrade(costBps)}
						<div
							role="tooltip"
							className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left font-['Sohne_Mono'] text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{executionGradeTooltip(costBps)}
						</div>
					</span>
				)}
			</div>

			{/* Detail table */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<DetailRow label="Txn Hash">
					<a
						href={`https://basescan.org/tx/${row.txHash}`}
						target="_blank"
						rel="noreferrer"
						className="underline decoration-dotted underline-offset-[3px] hover:decoration-solid"
					>
						{shortTxHash(row.txHash)}
					</a>
				</DetailRow>
				<DetailRow label="Chain">{chainLabel(row.chainId)}</DetailRow>
				<DetailRow label="Block">{row.blockNumber.toLocaleString()}</DetailRow>
				<DetailRow label="Aggregator">
					<span style={{ color: providerColor(row.aggregator.toLowerCase()) }}>
						{formatProvider(row.aggregator.toLowerCase())}
					</span>
				</DetailRow>

				<Divider dashed />

				<DetailRow label="Token In" subvalue={notionalSubvalue}>
					{formatTokenIn(row)}
				</DetailRow>
				<DetailRow label="Token Out" subvalue={notionalSubvalue}>
					{formatTokenOut(row)}
				</DetailRow>
				<DetailRow
					label="Realized Execution Price"
					subvalue={isPartial ? undefined : formatSubvalueUsd(Number(row.realizedPrice))}
				>
					{isPartial ? UNAVAILABLE : formatExecutionPrice(row.realizedPrice, priceUnit)}
				</DetailRow>
				<DetailRow
					label="Market Price"
					tooltip="Median of the traded pair’s reference pools at the trade’s block, cross-referenced against an on-chain price oracle"
					subvalue={isPartial ? undefined : formatSubvalueUsd(Number(row.marketMid))}
				>
					{isPartial ? UNAVAILABLE : formatExecutionPrice(row.marketMid, priceUnit)}
					{!isPartial && row.manipulationFlag ? (
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
					subvalue={isPartial ? undefined : priceDeltaComparison(row.marketMid, row.realizedPrice)}
				>
					{isPartial ? UNAVAILABLE : formatDelta(row.marketMid, row.realizedPrice)}
				</DetailRow>
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
				<BkdHeading label="Liquidity Provider Fee" plain />
				{legs.length > 0 ? (
					legs.map((leg, index) => {
						const { text: lpText, color: lpColor } = formatDialogBps(-leg.lpFeeBps);
						return (
							<BkdRow
								key={`${leg.venue}-${index}`}
								label={getVenueLabel(leg)}
								href={`https://basescan.org/address/${leg.venue}`}
								context={`${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`}
								value={lpText}
								color={lpColor}
								secondary
							/>
						);
					})
				) : (
					<BkdRow label="Route" value="–" secondary />
				)}

				<Divider dashed />

				{hasAggFee ? (
					<>
						<BkdHeading label="Aggregator Fee" plain />
						<BkdRow
							label={getAggregatorFeeAttribution(row).label}
							href={getAggregatorFeeAttribution(row).href}
							value={agg.text}
							color={agg.color}
							secondary
						/>
					</>
				) : (
					<BkdHeading label="Aggregator Fee" value="0.00bps" plain />
				)}

				<Divider dashed />

				{isPartial ? (
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
							<BkdRow label="Route" value="–" secondary />
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

			<ShareButton {...(sharePath !== undefined ? { path: sharePath } : {})} />
		</>
	);
}
