'use client';
import { useEffect, useMemo, useState } from 'react';
import type { RouteLeg, TradeRow, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatContribution,
	formatGasUsd,
	formatNotional,
	formatProvider,
	providerColor,
	shortTxHash,
} from '../lib/formatters';

const COL = 'p-0 py-[10px] pl-[28px] align-baseline';
const COL_FIRST = 'p-0 py-[10px] align-baseline';

const ACCESSORS: Record<TradesSortColumn, (r: TradeRow) => string | number> = {
	block: (r) => r.blockNumber,
	aggregator: (r) => r.aggregator.toLowerCase(),
	side: (r) => r.direction,
	size: (r) => Number(r.usdcAmount),
	accuracy: (r) => -Number(r.allInCostBps),
	lpFee: (r) => -Number(r.lpFeeBps ?? 0),
	aggFee: (r) => -Number(r.aggFeeBps ?? 0),
	impact: (r) => {
		const legs = normalizeRouteLegs(r.routeLegs);
		const hasPriceImpact = legs.some((l) => l.priceImpactBps != null);
		return hasPriceImpact ? -legs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0) : 0;
	},
	slippage: (r) => {
		const slip = r.slippageBps == null ? null : Number(r.slippageBps);
		const legs = normalizeRouteLegs(r.routeLegs);
		const hasPriceImpact = legs.some((l) => l.priceImpactBps != null);
		const impact = hasPriceImpact ? legs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0) : null;
		const residual = slip != null && impact != null ? slip - impact : slip;
		return -(residual ?? 0);
	},
	gas: (r) => Number(r.gasCostUsd ?? 0),
};

export function TradesTable({
	rows,
	initialSort,
}: {
	rows: TradeRow[];
	initialSort: TradesSort;
}) {
	const [sort, setSort] = useState<TradesSort | null>(null);
	const [selectedRow, setSelectedRow] = useState<TradeRow | null>(null);
	const effectiveSort = sort ?? initialSort;

	// TEMP: hiding trades over $3 for a presentation — remove this filter to restore them.
	const visibleRows = useMemo(() => rows.filter((r) => Number(r.usdcAmount) <= 3), [rows]);

	const sortedRows = useMemo(() => {
		const access = ACCESSORS[effectiveSort.column];
		const mul = effectiveSort.direction === 'asc' ? 1 : -1;
		return [...visibleRows].sort((a, b) => {
			const av = access(a);
			const bv = access(b);
			if (av < bv) return -mul;
			if (av > bv) return mul;
			return b.blockNumber - a.blockNumber;
		});
	}, [visibleRows, effectiveSort]);

	const onSort = (col: TradesSortColumn) => {
		let next: TradesSort | null;
		if (sort === null || sort.column !== col) {
			next = { column: col, direction: 'asc' };
		} else if (sort.direction === 'asc') {
			next = { column: col, direction: 'desc' };
		} else {
			next = null;
		}
		setSort(next);
		if (typeof window !== 'undefined') {
			const url = new URL(window.location.href);
			if (next === null) {
				url.searchParams.delete('sort');
				url.searchParams.delete('dir');
			} else {
				url.searchParams.set('sort', next.column);
				url.searchParams.set('dir', next.direction);
			}
			window.history.replaceState(null, '', url.toString());
		}
	};

	return (
		<div className="mt-[40px]">
			<table className="w-full font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<thead>
					<HeaderRow sort={sort} onSort={onSort} />
				</thead>
				<tbody>
					{sortedRows.map((r) => (
						<DataRow key={r.txHash} row={r} onOpen={setSelectedRow} />
					))}
				</tbody>
			</table>
			{selectedRow != null && (
				<TransactionDetailsDialog row={selectedRow} onClose={() => setSelectedRow(null)} />
			)}
		</div>
	);
}

function HeaderRow({
	sort,
	onSort,
}: {
	sort: TradesSort | null;
	onSort: (col: TradesSortColumn) => void;
}) {
	const TH = 'p-0 pb-[10px] pl-[28px] align-baseline font-medium text-right';
	return (
		<tr className="text-[var(--color-secondary)] uppercase font-medium">
			<th className="p-0 pb-[10px] align-baseline font-medium text-left">
				<SortHeader col="block" sort={sort} onSort={onSort} align="left">Block</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="aggregator" sort={sort} onSort={onSort}>Aggregator</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="size" sort={sort} onSort={onSort}>Size</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="accuracy" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-accuracy', text: 'Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage' }}>EX. QUALITY</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="lpFee" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-lp-fee', text: 'Fees paid to liquidity providers' }}>L.P. Fee</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="aggFee" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-agg-fee', text: 'Fees paid to aggregators' }}>Agg. Fee</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="impact" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-impact', text: 'Per-venue delta between execution price and the prior-block mid, excluding L.P. Fee' }}>P. IMPACT</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="slippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-slippage', text: 'Residual execution difference after L.P. Fee, Agg. Fee, and P. Impact' }}>Slippage</SortHeader>
			</th>
		</tr>
	);
}

function SortHeader({
	col,
	sort,
	onSort,
	className,
	align = 'right',
	tooltip,
	children,
}: {
	col: TradesSortColumn;
	sort: TradesSort | null;
	onSort: (col: TradesSortColumn) => void;
	className?: string;
	align?: 'left' | 'right';
	tooltip?: { id: string; text: string };
	children: React.ReactNode;
}) {
	const active = sort?.column === col;
	const arrow = active ? (sort!.direction === 'desc' ? ' ↓' : ' ↑') : '';
	return (
		<button
			type="button"
			onClick={() => onSort(col)}
			style={{ textAlign: align }}
			aria-describedby={tooltip?.id}
			className={`underline underline-offset-[2px] [text-decoration-skip-ink:none] whitespace-nowrap text-inherit font-inherit uppercase cursor-pointer hover:text-[var(--color-primary)] hover:decoration-solid ${
				active ? 'text-[var(--color-primary)] decoration-solid' : 'decoration-dotted'
			} ${tooltip ? 'group relative' : ''} ${className ?? ''}`}
		>
			{children}
			{arrow}
			{tooltip && (
				<div
					role="tooltip"
					id={tooltip.id}
					className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-[8px] w-max max-w-[320px] -translate-x-1/2 rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal not-italic normal-case whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible group-focus-visible:visible"
				>
					{tooltip.text}
				</div>
			)}
		</button>
	);
}

// Strips a leading '-' so table cells show magnitude only; color already
// conveys cost (uncolored) vs. surplus (green).
function stripSign(text: string): string {
	return text.replace(/^-/, '');
}

// Execution column: magnitude only, but with a leading '+' on positive
// (surplus) values to distinguish them from costs at a glance.
function formatAccuracySigned(costBps: number): string {
	const accuracy = -costBps;
	const rounded = Number(accuracy.toFixed(1));
	if (rounded === 0) return '0.0bps';
	return `${rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(1)}bps`;
}

function DataRow({ row, onOpen }: { row: TradeRow; onOpen: (row: TradeRow) => void }) {
	const costBps = Number(row.allInCostBps);
	const accuracy = -costBps;
	const accuracyColor = accuracy > 0.05 ? '#117d45' : undefined;

	const lp = formatContribution(row.lpFeeBps != null ? Number(row.lpFeeBps) : null);
	const agg = formatContribution(row.aggFeeBps != null ? Number(row.aggFeeBps) : null);
	const execution = getExecutionBreakdown(row);
	const impact = execution.priceImpactDisplay;
	const slip = execution.marketForcesDisplay;

	return (
		<tr
			className="cursor-pointer text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-low)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-focus)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
			onClick={() => onOpen(row)}
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } }}
		>
			<td className={COL_FIRST}>{row.blockNumber.toLocaleString()}</td>
			<td className={`${COL} text-right`} style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</td>
			<td className={`${COL} text-right`}>{formatNotional(Number(row.usdcAmount))}</td>
			<td className={`${COL} text-right`} style={accuracyColor ? { color: accuracyColor } : undefined}>{formatAccuracySigned(costBps)}</td>
			<td className={`${COL} text-right`} style={lp.color ? { color: lp.color } : undefined}>{stripSign(lp.text)}</td>
			<td className={`${COL} text-right`} style={agg.color ? { color: agg.color } : undefined}>{stripSign(agg.text)}</td>
			<td className={`${COL} text-right`} style={impact.color ? { color: impact.color } : undefined}>{impact.text}</td>
			<td className={`${COL} text-right`} style={slip.color ? { color: slip.color } : undefined}>{slip.text}</td>
		</tr>
	);
}

export function TransactionDetailsDialog({ row, onClose }: { row: TradeRow; onClose: () => void }) {
	const legs = normalizeRouteLegs(row.routeLegs);
	const costBps = Number(row.allInCostBps);
	const { text: accuracy, color: accuracyColor } = formatDialogBps(-costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs);

	const title = dialogPairTitle(legs, row);

	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = prev; };
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	return (
		<div className="fixed inset-0 z-layer-dialog-scrim overflow-y-auto bg-[rgba(15,15,15,0.20)] backdrop-blur-[2px]">
			<div
				className="flex min-h-full items-stretch justify-center px-[20px]"
				role="presentation"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) onClose();
				}}
			>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="transaction-details-title"
				className="flex w-full max-w-[694px] flex-col gap-[40px] bg-[var(--color-surface-base)] px-[40px] pt-[40px] pb-[40px] text-[var(--color-primary)] shadow-[8px_0px_8px_rgba(15,15,15,0.06),-8px_0px_8px_rgba(15,15,15,0.06)]"
			>
				<div className="flex items-center justify-between">
					<h2
						id="transaction-details-title"
						className="font-['Sohne_Breit'] text-[20px] leading-[20px] font-medium"
					>
						{shortTxHash(row.txHash)}
					</h2>
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
				</div>

				<div className="flex items-center justify-between">
					<h2
						className="font-['Sohne_Breit'] text-[20px] leading-[20px] font-medium"
					>
						{title}
					</h2>
					<span
						className="group relative cursor-default font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
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
					<DetailRow label="Aggregator"><span style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</span></DetailRow>
					<DetailRow label="Route">{routePath(legs)}</DetailRow>
					<DetailRow label="Token In" subvalue={formatSubvalueUsd(Number(row.usdcAmount))}>{formatTokenIn({ inputSymbol: 'USDC', inputAmount: row.usdcAmount })}</DetailRow>
					<DetailRow label="Token Out" subvalue={formatSubvalueUsd(Number(row.wethAmount) * Number(row.realizedPrice))}>{formatTokenOut({ outputSymbol: row.settledIn ?? 'WETH', outputAmount: row.wethAmount })}</DetailRow>
					<DetailRow label="Realized Execution Price" subvalue={formatSubvalueUsd(Number(row.realizedPrice))}>
						{formatExecutionPrice(row.realizedPrice)}
					</DetailRow>
					<DetailRow label="Market Price" tooltip="Median of three Uniswap v3/Aerodrome pools at the trade’s block, cross-referenced against Chainlink oracle" subvalue={formatSubvalueUsd(Number(row.marketMid))}>
						{formatExecutionPrice(row.marketMid)}
						{row.manipulationFlag ? (
							<span className="ml-2 text-[var(--color-warning)]" title="Median pool mid deviates from Chainlink ETH/USD by more than 0.5% at N-1">
								⚠ Possible manipulation
							</span>
						) : null}
					</DetailRow>
					{row.manipulationFlag && row.chainlinkDevBps != null ? (
						<DetailRow label="Chainlink Δ">
							{Number(row.chainlinkDevBps).toFixed(1)} bps
						</DetailRow>
					) : null}
					<DetailRow label="Price Delta" subvalue={priceDeltaComparison(row.marketMid, row.realizedPrice)}>
						{formatPriceDelta(row.marketMid, row.realizedPrice)}
					</DetailRow>
					<DetailRow label="Gas Cost">
						{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
					</DetailRow>
				</div>

				<h3 className="font-['Sohne_Breit'] text-[20px] leading-[20px] font-medium">
					Cost Breakdown
				</h3>

				<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
					<BreakdownHeading label="Liquidity Provider Fee" plain />
					{legs.length > 0 ? (
						legs.map((leg, index) => {
							const { text: lpText, color: lpColor } = formatDialogBps(-leg.lpFeeBps);
							return (
								<BreakdownRow
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
						<BreakdownRow label="Route" value="–" secondary />
					)}

					<BreakdownDivider />

					{hasAggFee ? (
						<>
							<BreakdownHeading label="Aggregator Fee" plain />
							<BreakdownRow
								label={getAggregatorFeeAttribution(row).label}
								href={getAggregatorFeeAttribution(row).href}
								value={agg.text}
								color={agg.color}
								secondary
							/>
						</>
					) : (
						<BreakdownHeading label="Aggregator Fee" value="0.00bps" plain />
					)}

					<BreakdownDivider />

					<BreakdownHeading label="Price Impact" tooltip="Per-venue delta between execution price and the prior-block mid, excluding L.P. fee" />
					{priceImpactRows.length > 0 ? (
						priceImpactRows.map((impact, index) => (
							<BreakdownRow
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
						<BreakdownRow label="Route" value="–" secondary />
					)}

					<BreakdownDivider />

					<BreakdownHeading
						label="Slippage"
						value={execution.slippageDisplay.text}
						color={execution.slippageDisplay.color}
						tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
					/>
					<BreakdownHeading
						label="Positive Slippage"
						value={execution.positiveSlippageDisplay.text}
						color={execution.positiveSlippageDisplay.color}
						tooltip="Residual benefit after L.P. fees, aggregator fees, and price impact"
					/>

					<BreakdownDivider />
					<BreakdownRow
						label="Total Execution Quality"
						value={accuracy}
						color={accuracyColor}
						tooltip="Delta between execution price and market price; the sum of L.P. Fee, Aggregator Fee, Price Impact, and Slippage"
					/>
				</div>

				<ShareButton path={`/receipts?tx=${row.txHash}`} />
			</section>
			</div>
		</div>
	);
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

export function formatSubvalueUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return '–';
	return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function BreakdownHeading({
	label,
	value,
	color,
	plain = false,
	tooltip,
}: {
	label: string;
	value?: string;
	color?: string | undefined;
	plain?: boolean;
	tooltip?: string;
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

function BreakdownDivider() {
	return (
		<div
			className="h-px"
			style={{
				backgroundImage:
					'repeating-linear-gradient(to right, var(--color-border) 0, var(--color-border) 1px, transparent 1px, transparent 3px)',
			}}
		/>
	);
}

export function ShareButton({ path }: { path?: string } = {}) {
	const [copied, setCopied] = useState(false);

	const handleClick = async () => {
		const url = path != null ? new URL(path, window.location.origin).toString() : window.location.href;
		await navigator.clipboard.writeText(url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className="flex h-[40px] w-full shrink-0 cursor-pointer items-center justify-center rounded-[2px] bg-[var(--color-primary)] px-[8px] font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] text-[var(--color-surface-base)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{copied ? 'Copied' : 'Share'}
		</button>
	);
}

function BreakdownRow({
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
	].filter(Boolean).join(' ');
	const labelNode = href ? (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`${labelClass} hover:decoration-solid`}
		>
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
						className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-[280px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible group-focus-visible:visible"
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

export function formatExecutionPrice(value: unknown, unitSymbol = 'WETH'): string {
	const n = value == null ? null : Number(value);
	if (n == null || Number.isNaN(n)) return '–';
	return `${trimNumber(n, 12)} = 1 ${unitSymbol}`;
}

export function formatDialogBps(value: number | null): { text: string; color: string | undefined } {
	if (value == null || !Number.isFinite(value)) return { text: '–', color: undefined };
	const rounded = Number(value.toFixed(2));
	const text = rounded === 0 ? '0.00bps' : `${rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(2)}bps`;
	const color = rounded > 0 ? '#117d45' : undefined;
	return { text, color };
}

// Reasonable letter-grade scale over Total Execution Quality (accuracy = -costBps).
// Meeting or beating market mid is top marks; grade degrades as cost grows.
export function executionGrade(costBps: number): string {
	const accuracy = -costBps;
	if (accuracy >= 0) return 'A+';
	if (accuracy >= -1) return 'A';
	if (accuracy >= -3) return 'B';
	if (accuracy >= -7) return 'C';
	if (accuracy >= -15) return 'D';
	return 'F';
}

// Describes each grade's cutoff. Total Execution Quality never shows a '-' sign
// on screen (see formatDialogBps), so the cutoffs here are stated unsigned too.
export function executionGradeTooltip(costBps: number): string {
	const accuracy = -costBps;
	if (accuracy >= 0) return 'Total Execution Quality is ≥0bps';
	if (accuracy >= -1) return 'Total Execution Quality is ≤1bps';
	if (accuracy >= -3) return 'Total Execution Quality is ≤3bps';
	if (accuracy >= -7) return 'Total Execution Quality is ≤7bps';
	if (accuracy >= -15) return 'Total Execution Quality is ≤15bps';
	return 'Total Execution Quality is >15bps';
}

export function getExecutionBreakdown(row: { slippageBps: string | number | null; routeLegs?: unknown }): {
	executionDisplay: { text: string; color: string | undefined };
	priceImpactDisplay: { text: string; color: string | undefined };
	marketForcesDisplay: { text: string; color: string | undefined };
	slippageDisplay: { text: string; color: string | undefined };
	positiveSlippageDisplay: { text: string; color: string | undefined };
} {
	const executionRaw =
		row.slippageBps == null || !Number.isFinite(Number(row.slippageBps))
			? null
			: Number(row.slippageBps);
	const legs = normalizeRouteLegs(row.routeLegs);
	const hasPriceImpact = legs.some((leg) => leg.priceImpactBps != null);
	const priceImpactRaw = hasPriceImpact
		? legs.reduce((sum, leg) => sum + (leg.priceImpactBps ?? 0), 0)
		: null;
	const marketForcesRaw =
		executionRaw != null && priceImpactRaw != null ? executionRaw - priceImpactRaw : executionRaw;

	// marketForcesRaw > 0 is a cost to the user; < 0 is a benefit. Split so each
	// row only ever carries one side, with the other pinned to 0.00bps.
	const slippageCostRaw = marketForcesRaw == null ? null : Math.max(marketForcesRaw, 0);
	const slippageBenefitRaw = marketForcesRaw == null ? null : Math.min(marketForcesRaw, 0);

	return {
		executionDisplay: formatDialogBps(executionRaw == null ? null : -executionRaw),
		priceImpactDisplay: formatDialogBps(priceImpactRaw == null ? null : -priceImpactRaw),
		marketForcesDisplay: formatDialogBps(marketForcesRaw == null ? null : -marketForcesRaw),
		slippageDisplay: formatDialogBps(slippageCostRaw == null ? null : -slippageCostRaw),
		positiveSlippageDisplay: formatDialogBps(slippageBenefitRaw == null ? null : -slippageBenefitRaw),
	};
}

export function getPriceImpactRows(legs: Pick<RouteLeg, 'venue' | 'type' | 'tokenIn' | 'tokenOut' | 'priceImpactBps'>[]): {
	label: string;
	href: string;
	context: string;
	value: string;
	color: string | undefined;
	valueTooltip?: string | undefined;
}[] {
	return legs.map((leg) => {
		const rawImpact = leg.priceImpactBps;
		const isNullImpact = rawImpact == null;
		const impact = isNullImpact
			? { text: 'Null', color: undefined }
			: formatDialogBps(-rawImpact);
		return {
			label: getVenueLabel(leg),
			href: `https://basescan.org/address/${leg.venue}`,
			context: `${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`,
			value: impact.text,
			color: impact.color,
			valueTooltip: isNullImpact ? getNullPriceImpactTooltip(leg) : undefined,
		};
	});
}

function getNullPriceImpactTooltip(leg: Pick<RouteLeg, 'type' | 'venue'>): string {
	if (leg.type === 'rfq' && !KNOWN_NON_RFQ_VENUES.has(leg.venue.toLowerCase())) {
		return 'The discovered RFQ reference mid was implausible or stale, so this leg is excluded from price-impact attribution.';
	}
	return 'No reliable reference mid was available for this leg, so it is excluded from price-impact attribution.';
}

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const TOKEN_SYMBOLS: Record<string, string> = {
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
	'0x4200000000000000000000000000000000000006': 'WETH',
	'0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
	'0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
	'0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
	'0x0555e30da8f98308edb960aa94c0db47230d2b9c': 'WBTC',
	'0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
	'0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
	'0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 'EURC',
	'0xa1f72459dfa10bad200ac160ecd78c6b77a747be': 'CLAWNCH',
	'0x7d928816cc9c462dd7adef911de41535e444cb07': 'FAIR',
	'0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07': 'CLAWD',
	'0x3722264ab15a1dfce5a5af89e6547f7949a8aba3': 'LFI',
	'0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3': 'GITLAWB',
};

const KNOWN_VENUE_LABELS: Record<string, string> = {
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969': 'Curve StableNG',
	'0x3eb210eaa4026f62d027fafaba1fa5592febb06a': 'Fabric OTC',
	'0x69e68e18f53889bdc7589e9f2defbf88e2d32de7': 'Fabric OTC',
	'0x73f0859f844f042cd699f35bb5fe13a120f95c0f': 'Fabric OTC',
	'0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap V4',
	'0xb94b22332abf5f89877a14cc88f2abc48c34b3df': 'Fabric OTC',
	'0xb1383dc47d9971fc999c3a9088f79e744b376e97': 'Hydrex',
	'0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76': 'UniPool',
};

const KNOWN_NON_RFQ_VENUES = new Set([
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969',
]);

export function tokenSymbol(address: string): string {
	return TOKEN_SYMBOLS[address.toLowerCase()] ?? shortAddress(address);
}

export function normalizeRouteLegs(routeLegs: unknown): RouteLeg[] {
	if (Array.isArray(routeLegs)) return routeLegs as RouteLeg[];
	if (typeof routeLegs !== 'string') return [];
	try {
		const parsed = JSON.parse(routeLegs);
		return Array.isArray(parsed) ? parsed as RouteLeg[] : [];
	} catch {
		return [];
	}
}

export function routePath(legs: RouteLeg[]): string {
	if (legs.length === 0) return '–';
	const tokens = [tokenSymbol(legs[0]!.tokenIn), ...legs.map((leg) => tokenSymbol(leg.tokenOut))];
	return tokens.join('->');
}

export function getFlagLabel(row: Pick<TradeRow, 'normalizeFlags' | 'decompConfidence'>): string {
	const flags = Array.isArray(row.normalizeFlags)
		? row.normalizeFlags.filter((flag): flag is string => typeof flag === 'string' && flag.trim().length > 0)
		: [];
	return flags.length > 0 ? flags.join('; ') : 'None';
}

// Generalized token display: reads the input/output symbol + amount fields that
// exist on both `ReceiptRow` (ReceiptView) and the History dialog's adapter.
export function formatTokenIn(row: { inputSymbol: string; inputAmount: string | number }): string {
	return `${trimNumber(Number(row.inputAmount), 6)} ${row.inputSymbol}`;
}

export function formatTokenOut(row: { outputSymbol: string; outputAmount: string | number }): string {
	return `${trimNumber(Number(row.outputAmount), 15)} ${row.outputSymbol}`;
}

export function getVenueLabel(leg: Pick<RouteLeg, 'type'> & Partial<Pick<RouteLeg, 'venue'>>): string {
	const knownLabel = leg.venue ? KNOWN_VENUE_LABELS[leg.venue.toLowerCase()] : undefined;
	if (knownLabel) return knownLabel;
	if (leg.type === 'sushiv3') return 'SushiSwap v3';
	if (leg.type === 'baseswapv3') return 'BaseSwap v3';
	if (leg.type === 'aerodrome_cl') return 'Aerodrome SlipStream';
	if (leg.type === 'curve_stableng') return 'Curve StableNG';
	if (leg.type === 'maverickv2') return 'Maverick v2';
	if (leg.type === 'aerodrome') return 'Aerodrome';
	if (leg.type === 'univ4') return 'Uni v4';
	if (leg.type === 'pancakev3') return 'Pancake v3';
	if (leg.type === 'univ3') return 'Uni v3';
	if (leg.type === 'univ2') return 'Uni v2';
	if (leg.type === 'rfq' || leg.type === 'unknown') return 'Unknown Pool';
	return leg.type.toUpperCase();
}

function firstLegContext(legs: RouteLeg[]): string | undefined {
	const leg = legs.find((l) => l.priceImpactBps != null) ?? legs[0];
	return leg ? `${tokenSymbol(leg.tokenIn)}->${tokenSymbol(leg.tokenOut)}` : undefined;
}

function aggregatorFeeLabel(row: { aggregator: string; aggFeeBps: string | number | null }): string {
	const provider = formatProvider(row.aggregator.toLowerCase());
	if (Number(row.aggFeeBps ?? 0) === 0) return provider;
	return `${provider} Fee`;
}

export function getAggregatorFeeAttribution(row: { aggregator: string; aggFeeBps: string | number | null }): {
	label: string;
	href?: string | undefined;
} {
	const vaults: Record<string, { label: string; href: string }> = {
		velora: {
			label: 'Augustus Fee Vault',
			href: 'https://basescan.org/address/0x00700052c0608F670705380a4900e0a8080010CC',
		},
		relay: {
			label: 'Relay: Solver',
			href: 'https://basescan.org/address/0xf70da97812CB96acDF810712Aa562db8dfA3dbEF',
		},
		kyberswap: {
			label: 'KyberSwap Fee Sink',
			href: 'https://basescan.org/address/0x4f82e73edb06d29ff62c91ec8f5ff06571bdeb29',
		},
	};
	const tagged = vaults[row.aggregator.toLowerCase()];
	if (tagged) return tagged;
	return { label: aggregatorFeeLabel(row) };
}

function trimNumber(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/, '');
}

function formatPriceDelta(marketMid: unknown, realizedPrice: unknown): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	return `$${Math.abs(mid - exec).toFixed(2)}`;
}

function priceDeltaComparison(marketMid: unknown, realizedPrice: unknown): string | undefined {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return undefined;
	if (Math.abs(exec - mid) < 0.01) return 'At Market';
	if (exec > mid) return 'Below Market';
	return 'Above Market';
}

function dialogPairTitle(legs: RouteLeg[], row: TradeRow): string {
	if (legs.length === 0) return row.settledIn ?? 'WETH';
	const tokens = [legs[0]!.tokenIn, ...legs.map((l) => l.tokenOut)];
	const symbols = tokens.map(tokenSymbol);
	return `${symbols[symbols.length - 1]}→${symbols[0]}`;
}
