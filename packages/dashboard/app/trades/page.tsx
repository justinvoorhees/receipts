import { getRecentSwaps } from '../../lib/queries';
import {
	formatAccuracy,
	formatBps,
	formatDirection,
	formatNotional,
	formatProvider,
	formatTradeTimestamp,
	shortTxHash,
} from '../../lib/formatters';

export const revalidate = 30;

export default async function TradesPage() {
	const rows = await getRecentSwaps();

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

function HeaderRow() {
	return (
		<div className="flex items-baseline justify-between gap-[40px] text-[var(--color-secondary)] uppercase font-medium">
			<div className="flex items-baseline gap-[16px]">
				<HeaderCell width="w-[96px]">Time</HeaderCell>
				<HeaderCell width="w-[80px]">Tx</HeaderCell>
				<HeaderCell width="w-[72px]">Aggregator</HeaderCell>
				<HeaderCell width="w-[64px]">Side</HeaderCell>
				<HeaderCell width="w-[72px]" align="right">
					Notional
				</HeaderCell>
			</div>
			<div className="flex items-baseline justify-end gap-[24px] text-right">
				<SortableHeader className="w-[58px]">Accuracy</SortableHeader>
				<SortableHeader className="w-[58px]">L.p. Fee</SortableHeader>
				<SortableHeader className="w-[58px]">Slippage</SortableHeader>
				<SortableHeader className="w-[58px]">Agg. fee</SortableHeader>
				<SortableHeader className="w-[58px]">Gas</SortableHeader>
			</div>
		</div>
	);
}

function HeaderCell({
	children,
	width,
	align = 'left',
}: {
	children: React.ReactNode;
	width: string;
	align?: 'left' | 'right';
}) {
	return (
		<span
			className={`${width} ${align === 'right' ? 'text-right' : ''} whitespace-nowrap`}
		>
			{children}
		</span>
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
					className="w-[80px] underline decoration-dotted underline-offset-[2px] hover:decoration-solid whitespace-nowrap"
				>
					{shortTxHash(row.txHash)}
				</a>
				<span className="w-[72px] whitespace-nowrap">
					{row.aggregator ? formatProvider(row.aggregator.toLowerCase()) : '–'}
				</span>
				<span className="w-[64px] whitespace-nowrap">{formatDirection(row.direction)}</span>
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
