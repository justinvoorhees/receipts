import { providerColor, formatProvider } from '../lib/formatters';
import type { AggregatorPoint, MetricStrategy } from '../lib/trustMatrix';

/**
 * 2×2 trust matrix.
 *
 * The plot is a true square: quadrant dividers sit at the geometric center
 * of the plot area (not at the data median), so each aggregator's dot
 * position is read against an absolute (0, max) scale on each axis. This
 * matches the Figma spec where the dividers are an absolute affordance
 * rather than a data-driven median line.
 *
 *   Y (severity →)
 *   ┌───────────────┬───────────────┐
 *   │   Volatile    │ Untrustworthy │  ← tinted red
 *   ├───────────────┼───────────────┤
 *   │ Trustworthy   │     Noisy     │  ← tinted green (bottom-left)
 *   └───────────────┴───────────────┘
 *                       X (frequency →)
 */

const MIN_SAMPLES = 5;

/**
 * Inset (percent) on each side of the plot. Dots at the data extremes
 * (value 0 or value max) would otherwise sit on the border and clip half
 * outside the matrix because of the `translate(-50%, -50%)` centering.
 */
const PLOT_INSET = 4;

/**
 * Cluster proximity threshold (percent). When two dots resolve to
 * positions within this distance on both axes, we treat them as a single
 * cluster and stack their labels next to one anchor point.
 */
const CLUSTER_TOLERANCE = 3;

export interface TrustMatrixProps {
	points: AggregatorPoint[];
	metric: MetricStrategy;
}

export function TrustMatrix({ points, metric }: TrustMatrixProps) {
	if (points.length === 0) {
		return (
			<div className="border border-[rgba(179,179,179,0.2)] aspect-square w-full flex items-center justify-center">
				<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] max-w-[400px] text-center">
					Awaiting ingestion — the trust matrix needs at least one aggregator with
					completed trades to plot.
				</p>
			</div>
		);
	}

	// Axes range from 0 to a padded max. Padding leaves a small buffer so the
	// rightmost / topmost dot doesn't kiss the border.
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const xMax = Math.max(...xs, 0) * 1.15 || 10;
	const yMax = Math.max(...ys, 0) * 1.15 || 10;
	const positioned = points.map((p) => ({
		...p,
		xPct: PLOT_INSET + (p.x / xMax) * (100 - 2 * PLOT_INSET),
		yPct: PLOT_INSET + (1 - p.y / yMax) * (100 - 2 * PLOT_INSET),
	}));
	const clusters = clusterByProximity(positioned, CLUSTER_TOLERANCE);

	return (
		<div className="relative w-full">
			{/* Y axis label */}
			<div
				className="absolute font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)]"
				style={{
					left: -16,
					top: '50%',
					transform: 'translate(-100%, -50%) rotate(-90deg)',
					transformOrigin: '100% 50%',
					whiteSpace: 'nowrap',
					fontFeatureSettings: '"calt" 0',
				}}
			>
				Severity
			</div>

			{/* Plot square */}
			<div className="relative aspect-square w-full border border-[rgba(179,179,179,0.2)]">
				{/* Quadrant tints — bottom-left green (trustworthy), top-right red (untrustworthy) */}
				<div className="absolute left-0 bottom-0 w-1/2 h-1/2 bg-[rgba(17,125,69,0.05)]" />
				<div className="absolute right-0 top-0 w-1/2 h-1/2 bg-[rgba(250,11,84,0.05)]" />

				{/* Crosshair lines at geometric center */}
				<div className="absolute left-0 right-0 top-1/2 h-px bg-[rgba(179,179,179,0.4)]" />
				<div className="absolute top-0 bottom-0 left-1/2 w-px bg-[rgba(179,179,179,0.4)]" />

				{/* Quadrant labels */}
				<QuadrantLabel pos="top-left" text="Volatile" />
				<QuadrantLabel pos="top-right" text="Untrustworthy" />
				<QuadrantLabel pos="bottom-left" text="Trustworthy" />
				<QuadrantLabel pos="bottom-right" text="Noisy" />

				{/* Aggregator dots, with co-located clusters rendered as a stacked label group */}
				{clusters.map((cluster, ci) => (
					<ClusterMarker key={ci} cluster={cluster} />
				))}
			</div>

			{/* X axis label */}
			<div
				className="font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)] text-center mt-[16px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Frequency
			</div>

			{/* sr-only axis units for accessibility */}
			<span className="sr-only">
				{metric.xLabel}: 0 to {xMax.toFixed(1)} {metric.unit}.
				{metric.yLabel}: 0 to {yMax.toFixed(1)} {metric.unit}.
			</span>
		</div>
	);
}

interface PositionedPoint extends AggregatorPoint {
	xPct: number;
	yPct: number;
}

/**
 * Group dots whose plot positions fall within `tolerance` percent of each
 * other on both axes. The first dot's position anchors the cluster; ties
 * resolve to insertion order. Returns clusters in input order so labels
 * read predictably.
 */
function clusterByProximity(
	points: PositionedPoint[],
	tolerance: number,
): PositionedPoint[][] {
	const clusters: PositionedPoint[][] = [];
	for (const p of points) {
		const existing = clusters.find(
			(c) =>
				Math.abs(c[0]!.xPct - p.xPct) < tolerance &&
				Math.abs(c[0]!.yPct - p.yPct) < tolerance,
		);
		if (existing) existing.push(p);
		else clusters.push([p]);
	}
	return clusters;
}

function ClusterMarker({ cluster }: { cluster: PositionedPoint[] }) {
	const anchor = cluster[0]!;
	// Below 50% on Y we render labels downward from the dot; above 50% we
	// render upward so labels never escape the plot.
	const labelsBelow = anchor.yPct < 50;
	return (
		<div
			className="absolute"
			style={{
				left: `${anchor.xPct}%`,
				top: `${anchor.yPct}%`,
				transform: 'translate(-50%, -50%)',
			}}
		>
			<div
				className={`flex ${labelsBelow ? 'flex-col' : 'flex-col-reverse'} items-start gap-[4px]`}
			>
				{cluster.map((p, i) => {
					const dim = p.sampleCount < MIN_SAMPLES;
					const color = providerColor(p.aggregator.toLowerCase());
					return (
						<div
							key={p.aggregator}
							className="flex items-center gap-[6px]"
							style={{ opacity: dim ? 0.5 : 1 }}
						>
							{/* Only the first entry shows a dot at the actual anchor; the
							    rest just show their color swatch + label so multi-aggregator
							    clusters read as 'these are all at this position'. */}
							<span
								aria-hidden="true"
								className="block"
								style={{
									width: i === 0 ? 8 : 6,
									height: i === 0 ? 8 : 6,
									borderRadius: 9999,
									backgroundColor: color,
									flex: 'none',
								}}
							/>
							<span
								className="font-['Sohne_Mono'] text-[12px] leading-[12px] whitespace-nowrap"
								style={{ color, fontFeatureSettings: '"calt" 0' }}
							>
								{formatProvider(p.aggregator.toLowerCase())}
								{dim ? ` (n=${p.sampleCount})` : ''}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function QuadrantLabel({
	pos,
	text,
}: {
	pos: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
	text: string;
}) {
	// Position each label at the center of its quadrant — 25% / 75% on each
	// axis. The center of the bottom-left quadrant is at (25%, 75%).
	const positions = {
		'top-left': { left: '25%', top: '25%' },
		'top-right': { left: '75%', top: '25%' },
		'bottom-left': { left: '25%', top: '75%' },
		'bottom-right': { left: '75%', top: '75%' },
	} as const;
	const style = positions[pos];
	return (
		<span
			className="absolute font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)] whitespace-nowrap"
			style={{
				...style,
				transform: 'translate(-50%, -50%)',
				fontFeatureSettings: '"calt" 0',
			}}
		>
			{text}
		</span>
	);
}
