export const revalidate = 30;

export default function DashboardIndex() {
	return (
		<div className="pb-10">
			<div className="flex items-baseline justify-between mt-[40px]">
				<h1 className="font-['Sohne_Breit'] font-medium text-[20px]">Execution Accuracy</h1>
				<p className="font-['Sohne_Mono'] font-medium text-[12px] uppercase text-[var(--color-secondary)]">
					Awaiting ingestion
				</p>
			</div>
			<p className="font-['Sohne_Mono'] text-[12px] text-[var(--color-secondary)] mt-10 max-w-[640px]">
				Once the ingest pipeline starts populating <code>swaps</code>, this page will host
				the aggregator leaderboard: a table-anchored breakdown of total cost, LP fee,
				aggregator fee, gas, and execution-quality residual — per provider, with size and
				time cross-cuts. Design is pending.
			</p>
		</div>
	);
}
