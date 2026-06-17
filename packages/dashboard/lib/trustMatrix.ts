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
 * Default strategy: median vs P95 of `executionQualityBps` clamped to
 * non-negative.
 *
 * Why clamp instead of `|bps|`: a negative residual is a *surplus* (user
 * got better than reference net of fees). Surpluses aren't inaccuracy — they
 * shouldn't pull the dot rightward. Clamping says costs count, surpluses are
 * free wins.
 *
 * Why median + P95 (not mean + stddev): median is robust to the tail; P95 is
 * the tail. The two carry independent information. Mean leaks tail signal;
 * stddev under-weights rare-but-large events (the volatile quadrant).
 */
export const DEFAULT_STRATEGY: MetricStrategy = {
	id: 'median-p95-clamped',
	xLabel: 'Median cost',
	yLabel: 'P95 cost',
	unit: 'bps',
	compute: (samples) => {
		const clamped = samples.map((s) => Math.max(0, s));
		return {
			x: quantile(clamped, 0.5),
			y: quantile(clamped, 0.95),
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
