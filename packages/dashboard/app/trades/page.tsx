import {
	getRecentTrades,
	TRADES_SORT_COLUMNS,
	type SortDirection,
	type TradesSort,
	type TradesSortColumn,
} from '../../lib/queries';
import { TradesTable } from '../../components/TradesTable';
import { DatasetToggle } from '../../components/DatasetToggle';
import { parseDataset } from '../../lib/datasets';

export const revalidate = 30;

const VALID_SORT_COLUMNS = new Set(Object.keys(TRADES_SORT_COLUMNS) as TradesSortColumn[]);
const DEFAULT_SORT: TradesSort = { column: 'block', direction: 'desc' };

export default async function TradesPage({
	searchParams,
}: {
	searchParams: Promise<{ sort?: string; dir?: string; ds?: string }>;
}) {
	const sp = await searchParams;
	const sort = parseSort(sp);
	const dataset = parseDataset(sp.ds);
	const rows = await getRecentTrades(sort, 500, dataset);

	return (
		<div className="pb-10">
			<div className="flex items-end justify-between mt-[40px]">
				<h1
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					Trades
				</h1>
				<div
					className="flex items-center gap-[10px] font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase text-[var(--color-secondary)] text-center"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					<span>{rows.length.toLocaleString()} trades</span>
					<span aria-hidden="true">•</span>
					<DatasetToggle dataset={dataset} />
				</div>
			</div>

			{rows.length === 0 ? (
				<EmptyState />
			) : (
				<TradesTable rows={rows} initialSort={sort} />
			)}
		</div>
	);
}

function parseSort(params: { sort?: string; dir?: string }): TradesSort {
	const column = (params.sort ?? '') as TradesSortColumn;
	if (!VALID_SORT_COLUMNS.has(column)) return DEFAULT_SORT;
	const direction: SortDirection = params.dir === 'asc' ? 'asc' : 'desc';
	return { column, direction };
}

function EmptyState() {
	return (
		<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[40px] max-w-[640px]">
			No trades yet — the table populates from the <code>router_trades</code> dataset.
		</p>
	);
}
