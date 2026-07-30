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
import { Receipt } from './receiptView';
// The shared display/format helpers now live in a leaf so ReceiptView can import
// them without the TradesTable ↔ ReceiptView cycle. The component below uses two
// of them directly; the rest are re-exported so existing import sites (the tests,
// which do `await import('./TradesTable')`) keep resolving unchanged.
import { getExecutionBreakdown, isMakerLeg, normalizeRouteLegs } from './receipt/receiptDisplay';
import { receiptPairTitle } from './receipt/priceFormat';
export * from './receipt/receiptDisplay';

const COL = 'p-0 py-[10px] pl-[28px] align-baseline';
// The Aggregator cell is the one left-aligned, variable-width column, so it is
// the first to wrap when the table is tight — nowrap makes it push the table
// wider (the wrapper below is sized to fit) instead of stacking onto two lines.
const COL_FIRST = 'p-0 py-[10px] align-baseline whitespace-nowrap';

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
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? Math.min(-(e.residualRawBps ?? 0), 0) : 0;
	},
	posSlippage: (r) => {
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? Math.max(-(e.residualRawBps ?? 0), 0) : 0;
	},
	unattributed: (r) => {
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? 0 : -(e.residualRawBps ?? 0);
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

	// The table deliberately breaks out of <main>'s 720px column so the
	// Aggregator cell never wraps. `w-max` sizes the wrapper to the widest row;
	// `left-1/2` + `-translate-x-1/2` re-centers it on the viewport (main is
	// itself centered, so its center line IS the viewport's). `min-w-full` keeps
	// a short table from collapsing narrower than the 720px column, and the
	// 100vw clamp bounds the wrapper's own width; `overflow-x-auto` scrolls the
	// table WITHIN that bounded box, so wide content (10 columns at ~1022px
	// natural width, wider than the clamp below ~1024px viewports) scrolls in
	// its own container instead of the page body.
	return (
		<>
			<div className="relative left-1/2 mt-[40px] w-max min-w-full max-w-[calc(100vw-40px)] -translate-x-1/2 overflow-x-auto">
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
			</div>
			{/* DO NOT move the dialog inside the breakout <div> above. Its scrim is
			    `fixed inset-0`, and that div carries a transform (-translate-x-1/2)
			    — a transformed ancestor becomes the containing block for `fixed`
			    descendants, so nesting it there re-anchors the scrim to the table's
			    box instead of the viewport and the modal renders off-center and
			    clipped. It must stay a sibling, outside the transform. */}
			{selectedRow != null && (
				<TransactionDetailsDialog row={selectedRow} onClose={() => setSelectedRow(null)} onDelete={handleDelete} />
			)}
		</>
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
				<SortHeader col="side" sort={sort} onSort={onSort}>Pair</SortHeader>
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
				<SortHeader col="slippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-slippage', text: 'Residual cost after L.P. Fee, Agg. Fee, and P. Impact' }}>Slippage</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="posSlippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-pos-slippage', text: 'Residual benefit after L.P. Fee, Agg. Fee, and P. Impact' }}>Pos. Slippage</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="unattributed" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-unattributed', text: 'Residual cost or benefit that could not be completely attributed, because some legs of this route were not priced' }}>Unattributed</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="accuracy" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-accuracy', text: 'Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage (or Unattributed)' }}>EX. QUALITY</SortHeader>
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
	// A market-maker (RFQ) leg carries lpFeeBps: 0, so a maker-only route
	// aggregates to a misleading 0.0bps. When the route has a maker leg and no
	// pool leg contributes a real L.P. fee, the fee is not applicable → show '–'.
	// (Mixed routes with a genuine pool leg keep their computed fee.)
	const legs = normalizeRouteLegs(row.routeLegs);
	const lpNotApplicable =
		legs.some(isMakerLeg) && !legs.some((l) => !isMakerLeg(l) && typeof l.lpFeeBps === 'number');
	const agg = formatContribution(row.aggFeeBps != null ? Number(row.aggFeeBps) : null);
	const execution = getExecutionBreakdown(row);
	const impact = execution.priceImpactDisplay;

	return (
		<tr
			className="group cursor-pointer text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-low)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-focus)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
			onClick={() => onOpen(row)}
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } }}
		>
			<td className={COL_FIRST} style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</td>
			<td className={`${COL} text-right whitespace-nowrap`}>{receiptPairTitle(row)}</td>
			<td className={`${COL} text-right`}>{formatNotional(row.notionalUsd != null ? Number(row.notionalUsd) : null)}</td>
			<td className={`${COL} text-right`} style={!lpNotApplicable && lp.color ? { color: lp.color } : undefined}>{lpNotApplicable ? '–' : stripSign(lp.text)}</td>
			<td className={`${COL} text-right`} style={agg.color ? { color: agg.color } : undefined}>{stripSign(agg.text)}</td>
			<td className={`${COL} text-right`} style={impact.color ? { color: impact.color } : undefined}>{impact.text}</td>
			<td className={`${COL} text-right`} style={execution.slippageDisplay.color ? { color: execution.slippageDisplay.color } : undefined}>{execution.fullyPriced ? execution.slippageDisplay.text : '–'}</td>
			<td className={`${COL} text-right`} style={execution.positiveSlippageDisplay.color ? { color: execution.positiveSlippageDisplay.color } : undefined}>{execution.fullyPriced ? execution.positiveSlippageDisplay.text : '–'}</td>
			<td className={`${COL} text-right`} style={execution.unattributedDisplay.color ? { color: execution.unattributedDisplay.color } : undefined}>{execution.fullyPriced ? '–' : execution.unattributedDisplay.text}</td>
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

