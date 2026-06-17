'use client';
import { useMemo, useState } from 'react';
import type { SwapRow, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatAccuracy,
	formatBps,
	formatDirection,
	formatNotional,
	formatProvider,
	formatTradeTimestamp,
	shortTxHash,
} from '../lib/formatters';

/**
 * Trades table — fully client-sorted. The server page renders the initial
 * row order from the URL searchParams (so a reload or a shared URL still
 * lands on a correctly-sorted page), but every subsequent click sorts in
 * memory and updates the URL via `history.replaceState` — no navigation,
 * no server fetch, no re-render of the page shell.
 *
 * Sort accessors are typed against the schema so a column rename in
 * `swaps` surfaces here as a type error.
 */

const ACCESSORS: Record<TradesSortColumn, (r: SwapRow) => string | number> = {
	time: (r) => r.blockTimestamp,
	aggregator: (r) => (r.aggregator ?? '').toLowerCase(),
	side: (r) => r.direction ?? '',
	notional: (r) => Number(r.notionalUsd ?? 0),
	// Accuracy is the sign-flipped framing of total cost (positive accuracy =
	// surplus). Sorting by `-totalCost` puts highest-accuracy rows first when
	// direction is desc, which matches the user's mental model.
	accuracy: (r) => -Number(r.totalCostBps ?? 0),
	lpFee: (r) => Number(r.lpFeeBps ?? 0),
	slippage: (r) => Number(r.slippageBps ?? 0),
	aggFee: (r) => Number(r.aggFeeBps ?? 0),
	gas: (r) => Number(r.gasCostBps ?? 0),
};

export function TradesTable({
	rows,
	initialSort,
}: {
	rows: SwapRow[];
	initialSort: TradesSort;
}) {
	const [sort, setSort] = useState<TradesSort>(initialSort);

	const sortedRows = useMemo(() => {
		const access = ACCESSORS[sort.column];
		const mul = sort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const av = access(a);
			const bv = access(b);
			if (av < bv) return -mul;
			if (av > bv) return mul;
			// Tie-break by block timestamp DESC so equal-cost rows still read newest-first.
			return Number(b.blockTimestamp) - Number(a.blockTimestamp);
		});
	}, [rows, sort]);

	const onSort = (col: TradesSortColumn) => {
		const nextDir: TradesSort['direction'] =
			sort.column === col && sort.direction === 'desc' ? 'asc' : 'desc';
		setSort({ column: col, direction: nextDir });
		// Silent URL sync — keeps the URL shareable and reload-correct without
		// triggering a Next navigation / server fetch.
		if (typeof window !== 'undefined') {
			const url = new URL(window.location.href);
			url.searchParams.set('sort', col);
			url.searchParams.set('dir', nextDir);
			window.history.replaceState(null, '', url.toString());
		}
	};

	return (
		<div className="mt-[40px] overflow-x-auto">
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px] min-w-fit">
				<HeaderRow sort={sort} onSort={onSort} />
				{sortedRows.map((r) => (
					<DataRow key={r.txHash} row={r} />
				))}
			</div>
		</div>
	);
}

function HeaderRow({
	sort,
	onSort,
}: {
	sort: TradesSort;
	onSort: (col: TradesSortColumn) => void;
}) {
	return (
		<div className="flex items-baseline justify-between gap-[40px] text-[var(--color-secondary)] uppercase font-medium">
			<div className="flex items-baseline gap-[16px]">
				<SortHeader col="time" sort={sort} onSort={onSort} className="w-[96px] text-left">
					Time
				</SortHeader>
				<span className="w-[80px] text-right whitespace-nowrap">TXN</span>
				<SortHeader col="aggregator" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Aggregator
				</SortHeader>
				<SortHeader col="side" sort={sort} onSort={onSort} className="w-[64px] text-right">
					Side
				</SortHeader>
				<SortHeader col="notional" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Size
				</SortHeader>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<SortHeader col="accuracy" sort={sort} onSort={onSort} className="w-[58px]">
					Accuracy
				</SortHeader>
				<SortHeader col="lpFee" sort={sort} onSort={onSort} className="w-[58px]">
					L.p. Fee
				</SortHeader>
				<SortHeader col="slippage" sort={sort} onSort={onSort} className="w-[58px]">
					Slippage
				</SortHeader>
				<SortHeader col="aggFee" sort={sort} onSort={onSort} className="w-[58px]">
					Agg. fee
				</SortHeader>
				<SortHeader col="gas" sort={sort} onSort={onSort} className="w-[58px]">
					Gas
				</SortHeader>
			</div>
		</div>
	);
}

function SortHeader({
	col,
	sort,
	onSort,
	className,
	children,
}: {
	col: TradesSortColumn;
	sort: TradesSort;
	onSort: (col: TradesSortColumn) => void;
	className?: string;
	children: React.ReactNode;
}) {
	const active = sort.column === col;
	const arrow = active ? (sort.direction === 'desc' ? ' ↓' : ' ↑') : '';
	return (
		<button
			type="button"
			onClick={() => onSort(col)}
			className={`underline decoration-dotted underline-offset-[2px] whitespace-nowrap text-inherit font-inherit uppercase cursor-pointer ${
				active ? 'text-[var(--color-primary)]' : ''
			} ${className ?? ''}`}
		>
			{children}
			{arrow}
		</button>
	);
}

function DataRow({ row }: { row: SwapRow }) {
	return (
		<div
			className="flex items-baseline justify-between gap-[40px] text-[var(--color-primary)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			<div className="flex items-baseline gap-[16px]">
				<span className="w-[96px] text-[var(--color-secondary)] whitespace-nowrap">
					{formatTradeTimestamp(row.blockTimestamp)}
				</span>
				<a
					href={`https://basescan.org/tx/${row.txHash}`}
					target="_blank"
					rel="noreferrer"
					className="w-[80px] text-right underline decoration-dotted underline-offset-[2px] hover:decoration-solid whitespace-nowrap"
				>
					{shortTxHash(row.txHash)}
				</a>
				<span className="w-[72px] text-right whitespace-nowrap">
					{row.aggregator ? formatProvider(row.aggregator.toLowerCase()) : '–'}
				</span>
				<span className="w-[64px] text-right whitespace-nowrap">
					{formatDirection(row.direction)}
				</span>
				<span className="w-[72px] text-right whitespace-nowrap">
					{formatNotional(row.notionalUsd !== null ? Number(row.notionalUsd) : null)}
				</span>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<span className="w-[58px]">
					{formatAccuracy(row.totalCostBps !== null ? Number(row.totalCostBps) : null)}
				</span>
				<span className="w-[58px]">
					{formatBps(row.lpFeeBps !== null ? Number(row.lpFeeBps) : null)}
				</span>
				<span className="w-[58px]">
					{formatBps(row.slippageBps !== null ? Number(row.slippageBps) : null)}
				</span>
				<span className="w-[58px]">
					{formatBps(row.aggFeeBps !== null ? Number(row.aggFeeBps) : null)}
				</span>
				<span className="w-[58px]">
					{formatBps(row.gasCostBps !== null ? Number(row.gasCostBps) : null)}
				</span>
			</div>
		</div>
	);
}
