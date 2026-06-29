'use client';
import { useMemo, useState } from 'react';
import { formatAccuracy, formatContribution, formatGasUsd, formatProvider, formatVariability } from '../lib/formatters';
import type { AggregatorSummaryRow } from '../lib/queries';

type SortColumn = 'aggregator' | 'accuracy' | 'lpFee' | 'aggFee' | 'slippage' | 'gas' | 'variability' | 'trades';
type SortDirection = 'asc' | 'desc';
interface Sort { column: SortColumn; direction: SortDirection }

const ACCESSORS: Record<SortColumn, (r: AggregatorSummaryRow) => string | number> = {
	aggregator: (r) => r.aggregator.toLowerCase(),
	accuracy: (r) => -r.medianCostBps,
	lpFee: (r) => -r.medianLpFeeBps,     // sign-flipped: sort matches display
	aggFee: (r) => -r.medianAggFeeBps,    // sign-flipped: sort matches display
	slippage: (r) => -r.medianSlippageBps, // sign-flipped: sort matches display
	gas: (r) => r.medianGasUsd,
	variability: (r) => r.stdevCostBps,
	trades: (r) => r.tradeCount,
};

const DEFAULT_SORT: Sort = { column: 'accuracy', direction: 'desc' };

export function AggregatorSummaryTable({ rows }: { rows: AggregatorSummaryRow[] }) {
	const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

	const sortedRows = useMemo(() => {
		const access = ACCESSORS[sort.column];
		const mul = sort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const av = access(a);
			const bv = access(b);
			if (av < bv) return -mul;
			if (av > bv) return mul;
			return 0;
		});
	}, [rows, sort]);

	const onSort = (col: SortColumn) => {
		const nextDir: SortDirection =
			sort.column === col && sort.direction === 'desc' ? 'asc' : 'desc';
		setSort({ column: col, direction: nextDir });
	};

	if (rows.length === 0) {
		return (
			<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)]">
				No trades yet — the table populates from the <code>router_trades</code> dataset.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-[20px] w-full font-['Sohne_Mono'] text-[12px] leading-[12px]">
			<HeaderRow sort={sort} onSort={onSort} />
			{sortedRows.map((r) => (
				<DataRow key={r.aggregator} row={r} />
			))}
		</div>
	);
}

function HeaderRow({ sort, onSort }: { sort: Sort; onSort: (col: SortColumn) => void }) {
	return (
		<div className="flex items-baseline justify-between text-[var(--color-secondary)] uppercase font-medium">
			<SortHeader col="aggregator" sort={sort} onSort={onSort} className="text-left">
				Aggregator
			</SortHeader>
			<div className="flex items-center justify-end gap-[24px] text-right">
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
				<SortHeader col="variability" sort={sort} onSort={onSort} className="w-[80px] text-right">
					Variability
				</SortHeader>
				<SortHeader col="trades" sort={sort} onSort={onSort} className="w-[58px] text-right">
					Trades
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
	col: SortColumn;
	sort: Sort;
	onSort: (col: SortColumn) => void;
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

function DataRow({ row }: { row: AggregatorSummaryRow }) {
	const thin = row.tradeCount < 5;
	const accuracy = -row.medianCostBps;
	const accuracyColor = accuracy > 0.05 ? '#117d45' : accuracy < -0.05 ? '#fa0b54' : undefined;

	const lp = formatContribution(row.medianLpFeeBps);
	const agg = formatContribution(row.medianAggFeeBps);
	const slip = formatContribution(row.medianSlippageBps);

	return (
		<div
			className="flex items-baseline justify-between text-[var(--color-primary)]"
			style={{ fontFeatureSettings: '"calt" 0', opacity: thin ? 0.5 : 1 }}
		>
			<span className="w-[72px]">{formatProvider(row.aggregator.toLowerCase())}</span>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<span className="w-[72px]" style={accuracyColor ? { color: accuracyColor } : undefined}>
					{formatAccuracy(row.medianCostBps)}
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
				<span className="w-[64px]">{formatGasUsd(row.medianGasUsd)}</span>
				<span className="w-[80px]">{formatVariability(row.stdevCostBps)}</span>
				<span className="w-[58px]">{row.tradeCount}</span>
			</div>
		</div>
	);
}
