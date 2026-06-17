import {
	getRecentSwaps,
	TRADES_SORT_COLUMNS,
	type SortDirection,
	type TradesSort,
	type TradesSortColumn,
} from '../../lib/queries';
import {
	formatAccuracy,
	formatBps,
	formatDirection,
	formatNotional,
	formatProvider,
	formatTradeTimestamp,
	shortTxHash,
} from '../../lib/formatters';
import { SortLink } from '../../components/SortLink';

export const revalidate = 30;

const VALID_SORT_COLUMNS = new Set(Object.keys(TRADES_SORT_COLUMNS) as TradesSortColumn[]);
const DEFAULT_SORT: TradesSort = { column: 'time', direction: 'desc' };

export default async function TradesPage({
	searchParams,
}: {
	searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
	const sort = parseSort(await searchParams);
	const rows = await getRecentSwaps(sort);

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
				</div>
			</div>

			{rows.length === 0 ? (
				<EmptyState />
			) : (
				<div className="mt-[40px] overflow-x-auto">
					<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px] min-w-fit">
						<HeaderRow />
						{rows.map((r) => (
							<DataRow key={r.txHash} row={r} />
						))}
					</div>
				</div>
			)}
		</div>
	);
}

type SwapRow = Awaited<ReturnType<typeof getRecentSwaps>>[number];

function parseSort(params: { sort?: string; dir?: string }): TradesSort {
	const column = (params.sort ?? '') as TradesSortColumn;
	if (!VALID_SORT_COLUMNS.has(column)) return DEFAULT_SORT;
	const direction: SortDirection = params.dir === 'asc' ? 'asc' : 'desc';
	return { column, direction };
}

function HeaderRow() {
	return (
		<div className="flex items-baseline justify-between gap-[40px] text-[var(--color-secondary)] uppercase font-medium">
			<div className="flex items-baseline gap-[16px]">
				<SortLink col="time" pathname="/trades" className="w-[96px] text-left">
					Time
				</SortLink>
				<StaticHeader className="w-[80px] text-right">TXN</StaticHeader>
				<SortLink col="aggregator" pathname="/trades" className="w-[72px] text-right">
					Aggregator
				</SortLink>
				<SortLink col="side" pathname="/trades" className="w-[64px] text-right">
					Side
				</SortLink>
				<SortLink col="notional" pathname="/trades" className="w-[72px] text-right">
					Size
				</SortLink>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<SortLink col="accuracy" pathname="/trades" className="w-[58px]">
					Accuracy
				</SortLink>
				<SortLink col="lpFee" pathname="/trades" className="w-[58px]">
					L.p. Fee
				</SortLink>
				<SortLink col="slippage" pathname="/trades" className="w-[58px]">
					Slippage
				</SortLink>
				<SortLink col="aggFee" pathname="/trades" className="w-[58px]">
					Agg. fee
				</SortLink>
				<SortLink col="gas" pathname="/trades" className="w-[58px]">
					Gas
				</SortLink>
			</div>
		</div>
	);
}

function StaticHeader({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <span className={`whitespace-nowrap ${className ?? ''}`}>{children}</span>;
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

function EmptyState() {
	return (
		<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[40px] max-w-[640px]">
			No promoted swaps yet. Run <code>tca-ingest poll</code> and{' '}
			<code>tca-ingest promote</code> against an archive RPC; rows appear here as the
			pipeline completes them.
		</p>
	);
}
