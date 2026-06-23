/**
 * Trust-matrix metric layer. The matrix plots each aggregator as a point in
 * (frequency × severity) space. The choice of *which* statistics map to the
 * two axes is a deliberate decision (see commit history for the reasoning),
 * but we expect it to evolve — different windows, different residual
 * components, different distributional cuts.
 *
 * Everything downstream (component, page) reads `strategy.xLabel`, `yLabel`,
 * `compute`. Add a new strategy here and the viz follows automatically.
 */

export interface AggregatorPoint {
	aggregator: string;
	x: number;
	y: number;
	sampleCount: number;
}

export interface MetricStrategy {
	id: string;
	xLabel: string;
	yLabel: string;
	/** Display units (e.g., "bps", "%"). Appended to axis-tick labels. */
	unit: string;
	/** Per-aggregator residual stream → (x, y) coordinates. */
	compute: (executionQualityBps: number[]) => { x: number; y: number };
}

/**
 * v2.0 strategy: median all-in cost (X) vs stddev (Y), over `all_in_cost_bps`
 * from `router_trades` (realized price vs market mid). The two axes are the two
 * failure modes and are decorrelated by construction (a center statistic vs a
 * spread statistic) — unlike the old stddev×P95 pair, which were both
 * tail-driven and collapsed Volatile/Untrustworthy onto one diagonal.
 *
 *   X = median cost  → high = "Overpriced" (consistently costs more than mid)
 *   Y = stddev cost  → high = "Volatile"   (large swings around its typical level)
 *
 * Quadrants (split at the cohort median of each axis): low/low = Trustworthy,
 * high-X/low-Y = Overpriced, low-X/high-Y = Volatile, high/high = Untrustworthy.
 * Cost is signed (negative = better than mid), so X spans negative→positive.
 */
export const DEFAULT_STRATEGY: MetricStrategy = {
	id: 'median-stddev',
	xLabel: 'Overpriced →',
	yLabel: 'Volatile →',
	unit: 'bps',
	compute: (samples) => {
		const n = samples.length;
		const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
		const variance = n > 1 ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
		return {
			x: quantile(samples, 0.5), // median cost vs mid (signed)
			y: Math.sqrt(variance),    // stddev: spread around the typical level
		};
	},
};

export function computeAggregatorPoints(
	rows: { aggregator: string | null; costBps: number }[],
	strategy: MetricStrategy = DEFAULT_STRATEGY,
): AggregatorPoint[] {
	const byAgg = new Map<string, number[]>();
	for (const r of rows) {
		if (!r.aggregator) continue;
		const arr = byAgg.get(r.aggregator) ?? [];
		arr.push(r.costBps);
		byAgg.set(r.aggregator, arr);
	}
	return Array.from(byAgg.entries()).map(([aggregator, samples]) => {
		const { x, y } = strategy.compute(samples);
		return { aggregator, x, y, sampleCount: samples.length };
	});
}

/**
 * Linear interpolation between order statistics — matches Excel/numpy's
 * default `linear` quantile method. Empty input returns 0.
 */
export function quantile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo]!;
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
