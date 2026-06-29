import { TrustMatrix } from '../components/TrustMatrix';
import { AggregatorSummaryTable } from '../components/AggregatorSummaryTable';
import { getCuratedAggregatorSummary, getCuratedCostByAggregator } from '../lib/queries';
import { DEFAULT_STRATEGY, computeAggregatorPoints } from '../lib/trustMatrix';

export const revalidate = 30;

export default async function DashboardIndex() {
	const [costSamples, summary] = await Promise.all([
		getCuratedCostByAggregator(),
		getCuratedAggregatorSummary(),
	]);
	const points = computeAggregatorPoints(costSamples, DEFAULT_STRATEGY);
	const totalTrades = summary.reduce((sum, r) => sum + r.tradeCount, 0);
	// Only aggregators with ≥5 trades are plotted on the matrix.
	const plottedCount = points.filter((p) => p.sampleCount >= 5).length;

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
						{plottedCount} {plottedCount === 1 ? 'Aggregator' : 'Aggregators'}
					</span>
					<span aria-hidden="true">•</span>
					<span>{totalTrades.toLocaleString()} trades</span>
				</div>
			</div>

			<div className="mt-[40px]">
				<TrustMatrix points={points} metric={DEFAULT_STRATEGY} />
			</div>

			<div className="mt-[40px]">
				<AggregatorSummaryTable rows={summary} />
			</div>
		</div>
	);
}
