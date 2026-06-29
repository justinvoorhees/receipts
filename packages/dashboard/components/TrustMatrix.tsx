import { providerColor, formatProvider } from '../lib/formatters';
import type { AggregatorPoint, MetricStrategy } from '../lib/trustMatrix';

const MIN_SAMPLES = 5;
const PLOT_INSET = 4;
const CLUSTER_TOLERANCE = 3;

export interface TrustMatrixProps {
	points: AggregatorPoint[];
	metric: MetricStrategy;
}

const median = (arr: number[]): number => {
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Dual-scale mapping: maps a value into [0%, 100%] with the split rendered
 * at exactly 50%. Values below the split are linearly mapped within [inset, 50%],
 * values above are mapped within [50%, 100% - inset]. This gives equal visual
 * quadrants while preserving the true meaning of each boundary.
 */
function dualScale(
	value: number,
	split: number,
	allValues: number[],
	inset: number,
): number {
	const belowSplit = allValues.filter(v => v < split);
	const aboveSplit = allValues.filter(v => v > split);

	const loMin = belowSplit.length > 0 ? Math.min(...belowSplit) : split;
	const hiMax = aboveSplit.length > 0 ? Math.max(...aboveSplit) : split;

	// Add padding so dots don't sit exactly on the edge
	const loPad = (split - loMin) * 0.18;
	const hiPad = (hiMax - split) * 0.18;
	const lo = loMin - loPad;
	const hi = hiMax + hiPad;

	if (value <= split) {
		// Map [lo .. split] -> [inset .. 50]
		const range = split - lo;
		if (range === 0) return 50;
		const t = (value - lo) / range;
		return inset + t * (50 - inset);
	} else {
		// Map [split .. hi] -> [50 .. 100 - inset]
		const range = hi - split;
		if (range === 0) return 50;
		const t = (value - split) / range;
		return 50 + t * (50 - inset);
	}
}

export function TrustMatrix({ points, metric }: TrustMatrixProps) {
	const plotted = points.filter((p) => p.sampleCount >= MIN_SAMPLES);
	if (plotted.length === 0) {
		return (
			<div className="aspect-square w-full flex items-center justify-center bg-[rgba(17,125,69,0.05)]">
				<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] max-w-[400px] text-center">
					Awaiting data — the trust matrix needs at least one aggregator with
					≥{MIN_SAMPLES} trades to plot.
				</p>
			</div>
		);
	}

	const xs = plotted.map((p) => p.x);
	const ys = plotted.map((p) => p.y);

	// X split: absolute 0 bps (negative = beat mid, positive = lost to mid)
	const xSplit = 0;
	// Y split: cohort median of stddev
	const yMedian = median(ys);

	// Dual-scale: each half gets independent linear mapping, split at 50%
	const xPctOf = (x: number) => dualScale(x, xSplit, xs, PLOT_INSET);
	// Y axis is inverted (up = higher value), so we invert after dual-scale
	const yPctOf = (y: number) => 100 - dualScale(y, yMedian, ys, PLOT_INSET);

	const positioned = plotted.map((p) => ({ ...p, xPct: xPctOf(p.x), yPct: yPctOf(p.y) }));
	const clusters = clusterByProximity(positioned, CLUSTER_TOLERANCE);

	// Splits always render at 50% for equal quadrants
	const xSplitPct = 50;
	const ySplitPct = 50;

	const leftC = xSplitPct / 2, rightC = (xSplitPct + 100) / 2;
	const topC = ySplitPct / 2, botC = (ySplitPct + 100) / 2;

	return (
		<div className="relative w-full" style={{ paddingLeft: 28, paddingBottom: 28 }}>
			{/* Y axis — "High" endpoint at top, "Severity" axis name centered, both at same left */}
			<div
				className="absolute flex items-center justify-center font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)]"
				style={{ left: 0, top: 0, width: 12, height: 28, fontFeatureSettings: '"calt" 0' }}
			>
				<span className="whitespace-nowrap" style={{ transform: 'rotate(-90deg)' }}>High</span>
			</div>
			<div
				className="absolute flex items-center justify-center font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)]"
				style={{ left: 0, top: '50%', transform: 'translateY(-50%)', width: 12, height: 56, fontFeatureSettings: '"calt" 0' }}
			>
				<span className="whitespace-nowrap" style={{ transform: 'rotate(-90deg)' }}>Severity</span>
			</div>

			{/* Plot square — no border, quadrant fills define edges */}
			<div className="relative aspect-square w-full overflow-hidden">
				{/* 4 equal quadrant tints — each 50% × 50% */}
				<div
					className="absolute bg-[rgba(251,168,8,0.05)]"
					style={{ left: 0, top: 0, width: '50%', height: '50%' }}
				/>
				<div
					className="absolute bg-[rgba(250,11,84,0.05)]"
					style={{ left: '50%', top: 0, width: '50%', height: '50%' }}
				/>
				<div
					className="absolute bg-[rgba(17,125,69,0.05)]"
					style={{ left: 0, top: '50%', width: '50%', height: '50%' }}
				/>
				<div
					className="absolute bg-[rgba(251,168,8,0.05)]"
					style={{ left: '50%', top: '50%', width: '50%', height: '50%' }}
				/>

				{/* Quadrant labels at center of each region */}
				<QuadrantLabel left={leftC} top={topC} text="Volatile" />
				<QuadrantLabel left={rightC} top={topC} text="Untrustworthy" />
				<QuadrantLabel left={leftC} top={botC} text="Trustworthy" />
				<QuadrantLabel left={rightC} top={botC} text="Overpriced" />

				{/* Aggregator dots */}
				{clusters.map((cluster, ci) => (
					<ClusterMarker key={ci} cluster={cluster} />
				))}
			</div>

			{/* X axis — "Low" aligned with Y axis labels at left:0, "Frequency" center, "High" right */}
			<div
				className="relative mt-[20px] h-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				<span className="absolute" style={{ left: -28 }}>Low</span>
				<span className="absolute left-1/2 -translate-x-1/2">Frequency</span>
				<span className="absolute right-0">High</span>
			</div>

			{/* sr-only axis description for accessibility */}
			<span className="sr-only">
				{metric.xLabel}: dual-scale axis, split at 0 {metric.unit} (rendered at 50%).
				Left half: values below 0 (beat mid). Right half: values above 0 (worse than mid).
				{metric.yLabel}: dual-scale axis, split at cohort median {yMedian.toFixed(1)} {metric.unit} (rendered at 50%).
				Below: lower spread than peers. Above: higher spread.
			</span>
		</div>
	);
}

interface PositionedPoint extends AggregatorPoint {
	xPct: number;
	yPct: number;
}

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
	const labelsBelow = anchor.yPct < 50;
	const ROW_HEIGHT_PX = 16;
	const DOT_PX = 8;
	return (
		<>
			{cluster.map((p, i) => {
				const yOffset = (labelsBelow ? i : -i) * ROW_HEIGHT_PX;
				const dim = p.sampleCount < MIN_SAMPLES;
				const color = providerColor(p.aggregator.toLowerCase());
				return (
					<div
						key={p.aggregator}
						className="absolute flex items-center gap-[6px]"
						style={{
							left: `${anchor.xPct}%`,
							top: `${anchor.yPct}%`,
							transform: `translate(${-DOT_PX / 2}px, calc(-50% + ${yOffset}px))`,
							opacity: dim ? 0.5 : 1,
						}}
					>
						<span
							aria-hidden="true"
							className="block"
							style={{
								width: DOT_PX,
								height: DOT_PX,
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
		</>
	);
}

function QuadrantLabel({ left, top, text }: { left: number; top: number; text: string }) {
	return (
		<span
			className="absolute font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-tertiary)] whitespace-nowrap pointer-events-none"
			style={{
				left: `${left}%`,
				top: `${top}%`,
				transform: 'translate(-50%, -50%)',
				fontFeatureSettings: '"calt" 0',
			}}
		>
			{text}
		</span>
	);
}
