import Link from 'next/link';
import { getRecentSwaps } from '../../lib/queries';
import {
	formatBps,
	formatDirection,
	formatGasUsd,
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
			<div className="flex items-baseline justify-between mt-[40px]">
				<h1 className="font-['Sohne_Breit'] font-medium text-[20px]">Trades</h1>
				<p className="font-['Sohne_Mono'] font-medium text-[12px] uppercase text-[var(--color-secondary)]">
					{rows.length} promoted
				</p>
			</div>

			{rows.length === 0 ? (
				<EmptyState />
			) : (
				<div className="mt-10 overflow-x-auto">
					<table className="w-full font-['Sohne_Mono'] text-[12px]">
						<thead>
							<tr className="text-left text-[var(--color-secondary)] uppercase">
								<Th sticky>Time</Th>
								<Th>Tx</Th>
								<Th>Aggregator</Th>
								<Th>Side</Th>
								<Th align="right">Notional</Th>
								<Th align="right">Total cost</Th>
								<Th align="right">LP fee</Th>
								<Th align="right">Agg fee</Th>
								<Th align="right">Gas (bps)</Th>
								<Th align="right">Gas ($)</Th>
								<Th align="right">Exec quality</Th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => {
								const execQuality = r.executionQualityBps !== null ? Number(r.executionQualityBps) : null;
								return (
									<tr
										key={r.txHash}
										className="border-t border-[var(--color-tertiary)]"
									>
										<Td sticky>{formatTradeTimestamp(r.blockTimestamp)}</Td>
										<Td>
											<a
												href={`https://basescan.org/tx/${r.txHash}`}
												target="_blank"
												rel="noreferrer"
												className="underline decoration-dotted hover:decoration-solid"
											>
												{shortTxHash(r.txHash)}
											</a>
										</Td>
										<Td>{r.aggregator ? formatProvider(r.aggregator.toLowerCase()) : '–'}</Td>
										<Td>{formatDirection(r.direction)}</Td>
										<Td align="right">
											{formatNotional(r.notionalUsd !== null ? Number(r.notionalUsd) : null)}
										</Td>
										<Td align="right">
											{formatBps(r.totalCostBps !== null ? Number(r.totalCostBps) : null)}
										</Td>
										<Td align="right">
											{formatBps(r.lpFeeBps !== null ? Number(r.lpFeeBps) : null)}
										</Td>
										<Td align="right">
											{formatBps(r.aggFeeBps !== null ? Number(r.aggFeeBps) : null)}
										</Td>
										<Td align="right">
											{formatBps(r.gasCostBps !== null ? Number(r.gasCostBps) : null)}
										</Td>
										<Td align="right">
											{formatGasUsd(r.gasCostUsd !== null ? Number(r.gasCostUsd) : null)}
										</Td>
										<Td align="right" {...toneProps(execQualityTone(execQuality))}>
											{formatBps(execQuality)}
										</Td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/**
 * Color tone for execution-quality residual. Positive bps = user paid more
 * than the explained costs (a hidden tax) — render in red. Negative = user
 * got surplus over reference even after fees — green. Near zero = quiet.
 */
function execQualityTone(bps: number | null): 'red' | 'green' | undefined {
	if (bps === null) return undefined;
	if (bps > 1) return 'red';
	if (bps < -1) return 'green';
	return undefined;
}

function toneProps(tone: 'red' | 'green' | undefined): { tone?: 'red' | 'green' } {
	return tone ? { tone } : {};
}

function EmptyState() {
	return (
		<p className="font-['Sohne_Mono'] text-[12px] text-[var(--color-secondary)] mt-10 max-w-[640px]">
			No promoted swaps yet. Run <code>tca-ingest poll</code> and{' '}
			<code>tca-ingest promote</code> against an archive RPC; rows appear here as the
			pipeline completes them.
		</p>
	);
}

function Th({
	children,
	sticky,
	align = 'left',
}: {
	children: React.ReactNode;
	sticky?: boolean;
	align?: 'left' | 'right';
}) {
	const base = 'py-2 px-3 font-medium text-[10px] tracking-wide';
	const stickyCls = sticky
		? 'sticky left-0 bg-[var(--color-background)] z-10'
		: '';
	const alignCls = align === 'right' ? 'text-right' : 'text-left';
	return <th className={`${base} ${alignCls} ${stickyCls}`}>{children}</th>;
}

function Td({
	children,
	sticky,
	align = 'left',
	tone,
}: {
	children: React.ReactNode;
	sticky?: boolean;
	align?: 'left' | 'right';
	tone?: 'red' | 'green';
}) {
	const base = 'py-2 px-3 align-baseline';
	const stickyCls = sticky
		? 'sticky left-0 bg-[var(--color-background)] z-10'
		: '';
	const alignCls = align === 'right' ? 'text-right tabular-nums' : 'text-left';
	const toneCls =
		tone === 'red'
			? 'text-[var(--color-red,#c44)]'
			: tone === 'green'
				? 'text-[var(--color-green,#3a7)]'
				: '';
	return <td className={`${base} ${alignCls} ${stickyCls} ${toneCls}`}>{children}</td>;
}
