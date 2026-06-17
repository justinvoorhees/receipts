import {
	formatAccuracy,
	formatBps,
	formatProvider,
	formatVariability,
} from '../lib/formatters';
import type { AggregatorSummaryRow } from '../lib/queries';

/**
 * Aggregator-level rollup table from the Figma dashboard. One row per
 * provider; columns are the five components of the TCA ledger plus the
 * variability (stddev) signal. Column header underlines (dotted) follow
 * the design convention for sortable columns — sorting is not wired yet,
 * the underline is purely affordance.
 */
export function AggregatorSummaryTable({ rows }: { rows: AggregatorSummaryRow[] }) {
	if (rows.length === 0) {
		return (
			<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)]">
				No completed swaps yet — the table populates as the ingest pipeline promotes
				rows into the swaps table.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-[20px] w-full font-['Sohne_Mono'] text-[12px] leading-[12px]">
			<HeaderRow />
			{rows.map((r) => (
				<DataRow key={r.aggregator} row={r} />
			))}
		</div>
	);
}

function HeaderRow() {
	return (
		<div className="flex items-baseline justify-between text-[var(--color-secondary)] uppercase font-medium">
			<span>Aggregator</span>
			<div className="flex items-center justify-end gap-[40px] text-right">
				<SortableHeader className="w-[58px]">Accuracy</SortableHeader>
				<SortableHeader className="w-[58px]">L.p. Fee</SortableHeader>
				<SortableHeader>Agg. fee</SortableHeader>
				<SortableHeader className="w-[58px]">Gas</SortableHeader>
				<SortableHeader className="w-[80px]">Variability</SortableHeader>
			</div>
		</div>
	);
}

function SortableHeader({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			className={`underline decoration-dotted underline-offset-[2px] whitespace-nowrap ${className ?? ''}`}
		>
			{children}
		</span>
	);
}

function DataRow({ row }: { row: AggregatorSummaryRow }) {
	return (
		<div
			className="flex items-baseline justify-between text-[var(--color-primary)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			<span className="w-[72px]">{formatProvider(row.aggregator.toLowerCase())}</span>
			<div className="flex items-baseline justify-end gap-[40px] text-right">
				<span className="w-[58px]">{formatAccuracy(row.avgTotalCostBps)}</span>
				<span className="w-[58px]">{formatBps(row.avgLpFeeBps)}</span>
				<span className="w-[58px]">{formatBps(row.avgAggFeeBps)}</span>
				<span className="w-[58px]">{formatBps(row.avgGasCostBps)}</span>
				<span className="w-[80px]">{formatVariability(row.variabilityBps)}</span>
			</div>
		</div>
	);
}
