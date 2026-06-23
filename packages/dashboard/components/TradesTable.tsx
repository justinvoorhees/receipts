'use client';
import { useMemo, useState } from 'react';
import type { RouterTradeRow, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatAccuracy,
	formatContribution,
	formatDirection,
	formatGasUsd,
	formatNotional,
	formatProvider,
	shortTxHash,
} from '../lib/formatters';

const ACCESSORS: Record<TradesSortColumn, (r: RouterTradeRow) => string | number> = {
	block: (r) => r.blockNumber,
	aggregator: (r) => r.aggregator.toLowerCase(),
	side: (r) => r.direction,
	size: (r) => Number(r.usdcAmount),
	accuracy: (r) => -Number(r.allInCostBps),
	lpFee: (r) => -Number(r.lpFeeBps ?? 0),     // sign-flipped: sort matches display
	aggFee: (r) => -Number(r.aggFeeBps ?? 0),    // sign-flipped: sort matches display
	slippage: (r) => -Number(r.slippageBps ?? 0), // sign-flipped: sort matches display
	gas: (r) => Number(r.gasCostUsd ?? 0),
};

export function TradesTable({
	rows,
	initialSort,
}: {
	rows: RouterTradeRow[];
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
			return b.blockNumber - a.blockNumber;
		});
	}, [rows, sort]);

	const onSort = (col: TradesSortColumn) => {
		const nextDir: TradesSort['direction'] =
			sort.column === col && sort.direction === 'desc' ? 'asc' : 'desc';
		setSort({ column: col, direction: nextDir });
		if (typeof window !== 'undefined') {
			const url = new URL(window.location.href);
			url.searchParams.set('sort', col);
			url.searchParams.set('dir', nextDir);
			window.history.replaceState(null, '', url.toString());
		}
	};

	return (
		<div className="mt-[40px]">
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
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
				<SortHeader col="block" sort={sort} onSort={onSort} className="w-[72px] text-left">
					Block
				</SortHeader>
				<span className="w-[80px] text-right whitespace-nowrap">TXN</span>
				<SortHeader col="aggregator" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Aggregator
				</SortHeader>
				<SortHeader col="side" sort={sort} onSort={onSort} className="w-[64px] text-right">
					Side
				</SortHeader>
				<SortHeader col="size" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Size
				</SortHeader>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<SortHeader col="accuracy" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Accuracy
				</SortHeader>
				<SortHeader col="lpFee" sort={sort} onSort={onSort} className="w-[72px] text-right">
					LP Fee
				</SortHeader>
				<SortHeader col="aggFee" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Agg Fee
				</SortHeader>
				<SortHeader col="slippage" sort={sort} onSort={onSort} className="w-[72px] text-right">
					Slippage
				</SortHeader>
				<SortHeader col="gas" sort={sort} onSort={onSort} className="w-[64px] text-right">
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

function DataRow({ row }: { row: RouterTradeRow }) {
	const costBps = Number(row.allInCostBps);
	const accuracy = -costBps;
	const accuracyColor = accuracy > 0.05 ? '#117d45' : accuracy < -0.05 ? '#fa0b54' : undefined;

	const lp = formatContribution(row.lpFeeBps != null ? Number(row.lpFeeBps) : null);
	const agg = formatContribution(row.aggFeeBps != null ? Number(row.aggFeeBps) : null);
	const slip = formatContribution(row.slippageBps != null ? Number(row.slippageBps) : null);

	return (
		<div
			className="flex items-baseline justify-between gap-[40px] text-[var(--color-primary)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			<div className="flex items-baseline gap-[16px]">
				<span className="w-[72px] text-[var(--color-secondary)] whitespace-nowrap">
					{row.blockNumber.toLocaleString()}
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
					{formatProvider(row.aggregator.toLowerCase())}
				</span>
				<span className="w-[64px] text-right whitespace-nowrap">
					{formatDirection(row.direction)}
				</span>
				<span className="w-[72px] text-right whitespace-nowrap">
					{formatNotional(Number(row.usdcAmount))}
				</span>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<span className="w-[72px]" style={accuracyColor ? { color: accuracyColor } : undefined}>
					{formatAccuracy(costBps)}
				</span>
				<span className="w-[72px]" style={lp.color ? { color: lp.color } : undefined}>
					{lp.text}
				</span>
				<span className="w-[72px]" style={agg.color ? { color: agg.color } : undefined}>
					{agg.text}
				</span>
				<span className="w-[72px]" style={slip.color ? { color: slip.color } : undefined}>
					{slip.text}
				</span>
				<span className="w-[64px]">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</span>
			</div>
		</div>
	);
}
