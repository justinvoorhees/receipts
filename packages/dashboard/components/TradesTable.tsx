'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ReceiptRow, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatContribution,
	formatNotional,
	formatProvider,
	providerColor,
} from '../lib/formatters';
import { Receipt } from './ReceiptView';
// The shared display/format helpers now live in a leaf so ReceiptView can import
// them without the TradesTable ↔ ReceiptView cycle. The component below uses two
// of them directly; the rest are re-exported so existing import sites (the tests,
// which do `await import('./TradesTable')`) keep resolving unchanged.
import { getExecutionBreakdown, normalizeRouteLegs } from './receipt/receiptDisplay';
export * from './receipt/receiptDisplay';

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

	// Delete: confirm, then either defer to an injected handler (tests) or hit
	// the DELETE route and refresh the server-rendered list. Returns whether the
	// delete proceeded, so callers (e.g. the dialog) know whether to close.
	const handleDelete = async (id: number): Promise<boolean> => {
		if (typeof window !== 'undefined' && !window.confirm('Delete this receipt?')) return false;
		if (onDelete) {
			onDelete(id);
			return true;
		}
		await fetch(`/api/receipts?id=${id}`, { method: 'DELETE' });
		router.refresh();
		return true;
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
						<DataRow key={r.id} row={r} onOpen={setSelectedRow} />
					))}
				</tbody>
			</table>
			{selectedRow != null && (
				<TransactionDetailsDialog row={selectedRow} onClose={() => setSelectedRow(null)} onDelete={handleDelete} />
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
	const TH_FIRST = 'p-0 pb-[10px] align-baseline font-medium text-left';
	return (
		<tr className="text-[var(--color-secondary)] uppercase font-medium">
			<th className={TH_FIRST}>
				<SortHeader col="aggregator" sort={sort} onSort={onSort} align="left">Aggregator</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="size" sort={sort} onSort={onSort}>Size</SortHeader>
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
			<th className={TH}>
				<SortHeader col="accuracy" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-accuracy', text: 'Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage' }}>EX. QUALITY</SortHeader>
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

function DataRow({
	row,
	onOpen,
}: {
	row: ReceiptRow;
	onOpen: (row: ReceiptRow) => void;
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
			<td className={COL_FIRST} style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</td>
			<td className={`${COL} text-right`}>{formatNotional(row.notionalUsd != null ? Number(row.notionalUsd) : null)}</td>
			<td className={`${COL} text-right`} style={lp.color ? { color: lp.color } : undefined}>{stripSign(lp.text)}</td>
			<td className={`${COL} text-right`} style={agg.color ? { color: agg.color } : undefined}>{stripSign(agg.text)}</td>
			<td className={`${COL} text-right`} style={impact.color ? { color: impact.color } : undefined}>{impact.text}</td>
			<td className={`${COL} text-right`} style={slip.color ? { color: slip.color } : undefined}>{slip.text}</td>
			<td className={`${COL} text-right`} style={accuracyColor ? { color: accuracyColor } : undefined}>{costBps == null ? '–' : formatAccuracySigned(costBps)}</td>
		</tr>
	);
}

/**
 * Row-click receipt dialog. The body is the same generalized `Receipt`
 * rendering used by the /receipts page (Task 10), so the two never drift.
 * This component only owns the modal shell: scrim, scroll-lock, Escape /
 * click-outside close, and the close button.
 */
export function TransactionDetailsDialog({
	row,
	onClose,
	onDelete,
}: {
	row: ReceiptRow;
	onClose: () => void;
	onDelete: (id: number) => Promise<boolean>;
}) {
	const handleDelete = async () => {
		if (await onDelete(row.id)) onClose();
	};

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
					className="relative flex w-full max-w-[720px] flex-col gap-[40px] bg-[var(--color-surface-base)] px-[40px] pt-[40px] pb-[40px] text-[var(--color-primary)] shadow-[8px_0px_8px_rgba(15,15,15,0.06),-8px_0px_8px_rgba(15,15,15,0.06)]"
				>
					<Receipt row={row} sharePath={`/?tx=${row.txHash}`} onClose={onClose} onDelete={handleDelete} />
				</section>
			</div>
		</div>
	);
}

