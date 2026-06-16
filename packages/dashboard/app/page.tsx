import { TrustMatrix } from '../components/TrustMatrix';
import { getResidualsByAggregator } from '../lib/queries';
import { DEFAULT_STRATEGY, computeAggregatorPoints } from '../lib/trustMatrix';

export const revalidate = 30;

export default async function DashboardIndex() {
	const residuals = await getResidualsByAggregator();
	const points = computeAggregatorPoints(residuals, DEFAULT_STRATEGY);

	return (
		<div className="pb-10">
			<div className="flex items-baseline justify-between mt-[40px]">
				<h1 className="font-['Sohne_Breit'] font-medium text-[20px]">Trust Matrix</h1>
				<p className="font-['Sohne_Mono'] font-medium text-[12px] uppercase text-[var(--color-secondary)]">
					{points.length} aggregators · {residuals.length} trades
				</p>
			</div>

			<div className="mt-10">
				<TrustMatrix points={points} metric={DEFAULT_STRATEGY} />
			</div>

			<p className="font-['Sohne_Mono'] text-[11px] text-[var(--color-secondary)] mt-6 max-w-[640px] leading-relaxed">
				Each dot is one aggregator. X is the median hidden cost (in basis points)
				beyond what lp / agg-fee / gas explain; Y is the P95 of the same series.
				Negative residuals (surpluses over reference) are clamped to zero — only
				costs count. Quadrant lines sit at the median of the plotted aggregators,
				so positions are comparative, not absolute. Dimmed dots indicate fewer
				than 5 samples.
			</p>
		</div>
	);
}
