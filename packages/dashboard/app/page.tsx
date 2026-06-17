import { TrustMatrix } from '../components/TrustMatrix';
import { AggregatorSummaryTable } from '../components/AggregatorSummaryTable';
import { FilterRow } from '../components/FilterRow';
import { getAggregatorSummary, getSlippageByAggregator } from '../lib/queries';
import { DEFAULT_STRATEGY, computeAggregatorPoints } from '../lib/trustMatrix';

export const revalidate = 30;

export default async function DashboardIndex() {
	const [slippage, summary] = await Promise.all([
		getSlippageByAggregator(),
		getAggregatorSummary(),
	]);
	const points = computeAggregatorPoints(slippage, DEFAULT_STRATEGY);
	const totalTrades = summary.reduce((sum, r) => sum + r.tradeCount, 0);

	return (
		<div className="pb-10">
			<div className="flex items-end justify-between mt-[40px]">
				<h1
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					Trust Matrix
				</h1>
				<div
					className="flex items-center gap-[10px] font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase text-[var(--color-secondary)] text-center"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					<span>
						{points.length} {points.length === 1 ? 'Aggregator' : 'Aggregators'}
					</span>
					<span aria-hidden="true">•</span>
					<span>{totalTrades.toLocaleString()} trades</span>
				</div>
			</div>

			<FilterRow />

			<div className="mt-[40px]">
				<TrustMatrix points={points} metric={DEFAULT_STRATEGY} />
			</div>

			<p
				className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[40px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Metrics based on accuracy and variability over time.
			</p>

			<div className="mt-[20px]">
				<AggregatorSummaryTable rows={summary} />
			</div>
		</div>
	);
}
