import {
	listReceipts,
	TRADES_SORT_COLUMNS,
	type SortDirection,
	type TradesSort,
	type TradesSortColumn,
} from '../../lib/queries';
import { TradesTable } from '../../components/tradesTable';
import { Divider } from '../../components/receipt/receiptRows';

export const revalidate = 30;

const VALID_SORT_COLUMNS = new Set(Object.keys(TRADES_SORT_COLUMNS) as TradesSortColumn[]);
const DEFAULT_SORT: TradesSort = { column: 'block', direction: 'desc' };

export default async function TradesPage({
	searchParams,
}: {
	searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
	const sp = await searchParams;
	const sort = parseSort(sp);
	// Receipts arrive newest-first (createdAt desc). The table applies the active
	// column sort client-side on top of this order.
	const rows = await listReceipts();

	return (
		<div className="pb-5">
			{/* The layout's <hr> was removed in the Figma v3 pass; /trades is not in
			    the frames, so it renders its own rule to keep today's appearance. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
			<div className="flex items-end justify-between mt-[40px]">
				<h1
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					History
				</h1>
				<div
					className="flex items-center gap-[10px] font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase text-[var(--color-secondary)] text-center"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					<span>{rows.length.toLocaleString()} receipts</span>
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
			No receipts yet — paste a transaction hash on the Receipts tab.
		</p>
	);
}
