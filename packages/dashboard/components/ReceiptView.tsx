'use client';
import { ReceiptSearch } from './ReceiptSearch';
import type { TradeRow, RouteLeg } from '../lib/queries';
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
	routePath,
	tokenSymbol,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
	executionGrade,
	executionGradeTooltip,
} from './TradesTable';

export function formatDelta(marketMid: unknown, realizedPrice: unknown): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	return `Execution - Market = $${Math.abs(mid - exec).toFixed(2)}`;
}

export function priceDeltaComparison(marketMid: unknown, realizedPrice: unknown): string | undefined {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return undefined;
	if (exec > mid) return 'Worse';
	if (exec < mid) return 'Better';
	return 'Market Value';
}

function receiptPairTitle(legs: RouteLeg[], row: TradeRow): string {
	if (legs.length === 0) return row.settledIn ?? 'WETH';
	const tokens = [legs[0]!.tokenIn, ...legs.map((l) => l.tokenOut)];
	const symbols = tokens.map(tokenSymbol);
	// Reverse to show pricing convention: "WETH→USDC" (last→first)
	return `${symbols[symbols.length - 1]}→${symbols[0]}`;
}

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
				<span className="group relative cursor-default text-[var(--color-secondary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
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
					className={`text-[var(--color-secondary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
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

export function ReceiptView({ trade, hash }: { trade: TradeRow | null; hash: string }) {
	const error = trade === null ? 'Transaction not found.' : undefined;

	return (
		<div className="flex flex-col gap-[40px] pb-10">
			<h1
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Create Receipt
			</h1>

			<ReceiptSearch hash={hash} {...(error !== undefined ? { error } : {})} />

			{trade != null && <Receipt row={trade} />}
		</div>
	);
}

function Receipt({ row }: { row: TradeRow }) {
	const legs = normalizeRouteLegs(row.routeLegs);
	const costBps = Number(row.allInCostBps);
	const { text: accuracy, color: accuracyColor } = formatDialogBps(-costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs);
	const pairTitle = receiptPairTitle(legs, row);

	return (
		<>
			<Divider color="border" />

			<div className="flex items-center justify-between">
				<h2
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					{pairTitle}
				</h2>
				<span
					className="group relative cursor-default font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
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
				<DetailRow label="Chain">Base</DetailRow>
				<DetailRow label="Block">{row.blockNumber.toLocaleString()}</DetailRow>
				<DetailRow label="Aggregator">
					<span style={{ color: providerColor(row.aggregator.toLowerCase()) }}>
						{formatProvider(row.aggregator.toLowerCase())}
					</span>
				</DetailRow>
				<DetailRow label="Route">{routePath(legs)}</DetailRow>

				<Divider dashed />

				<DetailRow
					label="Token In"
					subvalue={formatSubvalueUsd(Number(row.usdcAmount))}
				>
					{formatTokenIn(row)}
				</DetailRow>
				<DetailRow
					label="Token Out"
					subvalue={formatSubvalueUsd(Number(row.wethAmount) * Number(row.realizedPrice))}
				>
					{formatTokenOut(row)}
				</DetailRow>
				<DetailRow
					label="Realized Execution Price"
					subvalue={formatSubvalueUsd(Number(row.realizedPrice))}
				>
					{formatExecutionPrice(row.realizedPrice)}
				</DetailRow>
				<DetailRow
					label="Market Price"
					tooltip="Median of three Uniswap v3/Aerodrome pools at the trade’s block, cross-referenced against Chainlink oracle"
					subvalue={formatSubvalueUsd(Number(row.marketMid))}
				>
					{formatExecutionPrice(row.marketMid)}
					{row.manipulationFlag ? (
						<span
							className="ml-2"
							style={{ color: 'var(--color-yellow)' }}
							title="Median pool mid deviates from Chainlink ETH/USD by more than 0.5% at N-1"
						>
							⚠ Possible manipulation
						</span>
					) : null}
				</DetailRow>
				<DetailRow label="Price Delta" subvalue={priceDeltaComparison(row.marketMid, row.realizedPrice)}>
					{formatDelta(row.marketMid, row.realizedPrice)}
				</DetailRow>
				<DetailRow label="Gas Cost">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</DetailRow>
			</div>

			<Divider color="border" />

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

				<Divider color="border" />
				<BkdRow
				label="Total Execution Quality"
				value={accuracy}
				color={accuracyColor}
				tooltip="Delta between execution price and market price; the sum of L.P. Fee, Agg Fee, P. Impact, and Slippage"
			/>
			</div>
		</>
	);
}
