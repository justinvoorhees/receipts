'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ReceiptRow, RouteLeg, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatContribution,
	formatNotional,
	formatProvider,
	providerColor,
} from '../lib/formatters';
import { Receipt } from './ReceiptView';

const COL = 'p-0 py-[10px] pl-[28px] align-baseline';
const COL_FIRST = 'p-0 py-[10px] align-baseline';

const ACCESSORS: Record<TradesSortColumn, (r: ReceiptRow) => string | number> = {
	block: (r) => r.blockNumber,
	aggregator: (r) => r.aggregator.toLowerCase(),
	// "side" = input→output symbols; we never parse `direction`.
	side: (r) => `${r.inputSymbol}->${r.outputSymbol}`,
	size: (r) => Number(r.notionalUsd ?? 0),
	accuracy: (r) => -Number(r.allInCostBps ?? 0),
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
	onDelete,
}: {
	rows: ReceiptRow[];
	initialSort: TradesSort;
	onDelete?: (id: number) => void;
}) {
	const router = useRouter();
	const [sort, setSort] = useState<TradesSort | null>(null);
	const [selectedRow, setSelectedRow] = useState<ReceiptRow | null>(null);
	const effectiveSort = sort ?? initialSort;

	const sortedRows = useMemo(() => {
		const access = ACCESSORS[effectiveSort.column];
		const mul = effectiveSort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const av = access(a);
			const bv = access(b);
			if (av < bv) return -mul;
			if (av > bv) return mul;
			return b.blockNumber - a.blockNumber;
		});
	}, [rows, effectiveSort]);

	// Per-row delete: confirm, then either defer to an injected handler (tests)
	// or hit the DELETE route and refresh the server-rendered list.
	const handleDelete = async (id: number) => {
		if (typeof window !== 'undefined' && !window.confirm('Delete this receipt?')) return;
		if (onDelete) {
			onDelete(id);
			return;
		}
		await fetch(`/api/receipts?id=${id}`, { method: 'DELETE' });
		router.refresh();
	};

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
						<DataRow key={r.id} row={r} onOpen={setSelectedRow} onDelete={handleDelete} />
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
			<th className="p-0 pb-[10px] pl-[28px] align-baseline w-[24px]" aria-hidden="true" />
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

function DataRow({
	row,
	onOpen,
	onDelete,
}: {
	row: ReceiptRow;
	onOpen: (row: ReceiptRow) => void;
	onDelete: (id: number) => void;
}) {
	// Partial receipts have no cost model, so guard every cost field and render "–".
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const accuracy = costBps == null ? null : -costBps;
	const accuracyColor = accuracy != null && accuracy > 0.05 ? '#117d45' : undefined;

	const lp = formatContribution(row.lpFeeBps != null ? Number(row.lpFeeBps) : null);
	const agg = formatContribution(row.aggFeeBps != null ? Number(row.aggFeeBps) : null);
	const execution = getExecutionBreakdown(row);
	const impact = execution.priceImpactDisplay;
	const slip = execution.marketForcesDisplay;

	return (
		<tr
			className="group cursor-pointer text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-low)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-focus)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
			onClick={() => onOpen(row)}
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } }}
		>
			<td className={COL_FIRST}>{row.blockNumber.toLocaleString()}</td>
			<td className={`${COL} text-right`} style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</td>
			<td className={`${COL} text-right`}>{formatNotional(row.notionalUsd != null ? Number(row.notionalUsd) : null)}</td>
			<td className={`${COL} text-right`} style={accuracyColor ? { color: accuracyColor } : undefined}>{costBps == null ? '–' : formatAccuracySigned(costBps)}</td>
			<td className={`${COL} text-right`} style={lp.color ? { color: lp.color } : undefined}>{stripSign(lp.text)}</td>
			<td className={`${COL} text-right`} style={agg.color ? { color: agg.color } : undefined}>{stripSign(agg.text)}</td>
			<td className={`${COL} text-right`} style={impact.color ? { color: impact.color } : undefined}>{impact.text}</td>
			<td className={`${COL} text-right`} style={slip.color ? { color: slip.color } : undefined}>{slip.text}</td>
			<td className={`${COL} text-right`}>
				<button
					type="button"
					aria-label="Delete receipt"
					title="Delete receipt"
					onClick={(e) => { e.stopPropagation(); onDelete(row.id); }}
					className="cursor-pointer text-[var(--color-secondary)] opacity-0 transition-opacity hover:text-[var(--color-primary)] group-hover:opacity-100 focus-visible:opacity-100"
				>
					✕
				</button>
			</td>
		</tr>
	);
}

/**
 * Row-click receipt dialog. The body is the same generalized `Receipt`
 * rendering used by the /receipts page (Task 10), so the two never drift.
 * This component only owns the modal shell: scrim, scroll-lock, Escape /
 * click-outside close, and the close button.
 */
export function TransactionDetailsDialog({ row, onClose }: { row: ReceiptRow; onClose: () => void }) {
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
					aria-label="Transaction receipt"
					className="relative flex w-full max-w-[694px] flex-col gap-[40px] bg-[var(--color-surface-base)] px-[40px] pt-[40px] pb-[40px] text-[var(--color-primary)] shadow-[8px_0px_8px_rgba(15,15,15,0.06),-8px_0px_8px_rgba(15,15,15,0.06)]"
				>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close transaction details"
						className="absolute right-[40px] top-[40px] z-10 flex h-[40px] w-[40px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] p-[8px] text-[var(--color-primary)] transition-colors hover:bg-[var(--color-surface-low)] active:bg-[var(--color-surface-low)]"
					>
						<span aria-hidden="true" className="relative block h-[18px] w-[18px]">
							<span className="absolute left-1/2 top-0 h-[18px] w-[2px] -translate-x-1/2 rotate-45 bg-current" />
							<span className="absolute left-1/2 top-0 h-[18px] w-[2px] -translate-x-1/2 -rotate-45 bg-current" />
						</span>
					</button>

					<Receipt row={row} sharePath={`/receipts?tx=${row.txHash}`} />
				</section>
			</div>
		</div>
	);
}

export function formatSubvalueUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return '–';
	return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

export function getFlagLabel(row: Partial<Pick<ReceiptRow, 'normalizeFlags' | 'decompConfidence'>>): string {
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

// Fabric's own protocol fee defaults to 0 bps and is capped at 10 bps
// (surplus-sharing only — see docs.withfabric.xyz/apis/quotes/fees). Fabric
// is also the *router* for every trade routed through it, so any retained
// fee we detect there is presented under the "Fabric" aggregator label even
// when it's actually an integrator/partner's `feeBps` being forwarded to
// their `feeRecipient` (integrators can set up to 1000 bps). A fee above
// this cap attributed to the Fabric router is therefore definitionally NOT
// Fabric revenue — label it neutrally instead of implying Fabric earned it.
const FABRIC_AGGREGATOR_SLUG = 'fabric';
const FABRIC_MAX_PROTOCOL_FEE_BPS = 10;

// Known Fabric integrator fee-recipient addresses (lowercase) -> display name.
// A forwarded Fabric fee (aggFeeBps > FABRIC_MAX_PROTOCOL_FEE_BPS) is definitionally
// an integrator/partner's feeBps, not Fabric revenue (see cap above); the persisted
// `feeRecipient` is the on-chain wallet that actually received it. This registry
// names the integrator once we've positively identified their wallet. Add entries
// here as more integrators are confirmed — do NOT assume a name for an unmapped
// recipient.
const INTEGRATOR_FEE_RECIPIENTS: Record<string, string> = {
	// Farcaster/Warplet fee-collection wallet: a high-frequency EOA fed ~0.8%
	// output-side fees by the Fabric router (WARP = the "Warplet" token; ~0.8%
	// matches the Warpcast wallet swap fee).
	'0x403560800cb7e03a06ebbc991dba0f6ac751a1c5': 'Farcaster',
};

// Resolves a persisted fee-recipient address to an "Integrator Fee (<Name>)" label
// when the recipient is a known integrator, or a neutral "Integrator Fee" when the
// recipient is missing or unrecognized. Never invents a name.
function integratorFeeLabel(feeRecipient: string | null | undefined): string {
	const name = feeRecipient ? INTEGRATOR_FEE_RECIPIENTS[feeRecipient.toLowerCase()] : undefined;
	return name ? `Integrator Fee (${name})` : 'Integrator Fee';
}

function aggregatorFeeLabel(row: { aggregator: string; aggFeeBps: string | number | null; feeRecipient?: string | null }): string {
	const provider = formatProvider(row.aggregator.toLowerCase());
	const feeBps = Number(row.aggFeeBps ?? 0);
	if (feeBps === 0) return provider;
	if (row.aggregator.toLowerCase() === FABRIC_AGGREGATOR_SLUG) {
		// > 10bps: definitively an integrator/partner fee forwarded through the
		// Fabric router, not Fabric's own revenue (see cap above).
		// <= 10bps: genuinely ambiguous from on-chain data alone — could be
		// Fabric's surplus-share fee OR a small integrator fee. Use a neutral
		// label rather than crediting either party without evidence.
		return feeBps > FABRIC_MAX_PROTOCOL_FEE_BPS ? integratorFeeLabel(row.feeRecipient) : 'Router Fee';
	}
	return `${provider} Fee`;
}

export function getAggregatorFeeAttribution(row: { aggregator: string; aggFeeBps: string | number | null; feeRecipient?: string | null }): {
	label: string;
	href?: string | undefined;
	tooltip?: string | undefined;
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
	const label = aggregatorFeeLabel(row);
	const isFabricIntegratorFee =
		row.aggregator.toLowerCase() === FABRIC_AGGREGATOR_SLUG &&
		Number(row.aggFeeBps ?? 0) > FABRIC_MAX_PROTOCOL_FEE_BPS;
	if (isFabricIntegratorFee) {
		const knownIntegrator = row.feeRecipient
			? INTEGRATOR_FEE_RECIPIENTS[row.feeRecipient.toLowerCase()]
			: undefined;
		return {
			label,
			// Link to the persisted feeRecipient (the integrator's fee wallet) when available.
			href: row.feeRecipient ? `https://basescan.org/address/${row.feeRecipient}` : undefined,
			tooltip:
				'Fabric’s own protocol fee is 0bps by default (max 10bps, surplus-sharing only). ' +
				'A fee this size is an integrator’s feeBps, forwarded by the Fabric router to their feeRecipient — not Fabric revenue.' +
				(knownIntegrator ? '' : ' The specific integrator has not been identified.'),
		};
	}
	if (label === 'Router Fee') {
		return {
			label,
			tooltip:
				'Retained by an address reached via the Fabric router. Within Fabric’s own protocol-fee range ' +
				'(0–10bps, surplus-sharing), but on-chain data alone can’t confirm whether this is Fabric’s fee ' +
				'or a small partner feeBps — shown neutrally.',
		};
	}
	return { label };
}

function trimNumber(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/, '');
}
