import { providerColor, formatProvider } from '../lib/formatters';
import type { AggregatorPoint, MetricStrategy } from '../lib/trustMatrix';

/**
 * 2×2 trust matrix.
 *
 * Axes are driven entirely by the `metric` strategy (label + unit). The
 * quadrant boundaries sit at the data's own median on each axis — i.e.
 * positions are relative, not against a fixed threshold. That means the
 * matrix always tells a comparative story: "trustworthy among these
 * providers in this window," not "trustworthy in absolute terms."
 *
 *   Y (severity →)
 *   ┌───────────────┬───────────────┐
 *   │   Volatile    │ Untrustworthy │
 *   ├───────────────┼───────────────┤
 *   │ Trustworthy   │     Noisy     │
 *   └───────────────┴───────────────┘
 *                     X (frequency →)
 */

const W = 640;
const H = 480;
const M = { top: 40, right: 40, bottom: 56, left: 64 } as const;
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const MIN_SAMPLES = 5;

export interface TrustMatrixProps {
	points: AggregatorPoint[];
	metric: MetricStrategy;
}

export function TrustMatrix({ points, metric }: TrustMatrixProps) {
	if (points.length === 0) {
		return (
			<p className="font-['Sohne_Mono'] text-[12px] text-[var(--color-secondary)] mt-10 max-w-[640px]">
				No promoted swaps yet — the trust matrix needs at least one aggregator with
				completed trades to plot. Run the ingest pipeline against an archive RPC and
				this will populate.
			</p>
		);
	}

	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const xMax = Math.max(...xs, 0) * 1.15 || 10;
	const yMax = Math.max(...ys, 0) * 1.15 || 10;
	const xMid = median(xs);
	const yMid = median(ys);

	const xToPx = (x: number) => M.left + (x / xMax) * PLOT_W;
	const yToPx = (y: number) => M.top + (1 - y / yMax) * PLOT_H;

	const xMidPx = xToPx(xMid);
	const yMidPx = yToPx(yMid);

	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			width="100%"
			role="img"
			aria-label={`Trust matrix: ${metric.xLabel} vs ${metric.yLabel}`}
			className="font-['Sohne_Mono']"
		>
			{/* Quadrant tints. Bottom-left is the goal state — gets a faint accent. */}
			<rect
				x={M.left}
				y={yMidPx}
				width={xMidPx - M.left}
				height={M.top + PLOT_H - yMidPx}
				fill="var(--color-fabric-green, #3a7)"
				opacity="0.06"
			/>
			<rect
				x={xMidPx}
				y={M.top}
				width={M.left + PLOT_W - xMidPx}
				height={yMidPx - M.top}
				fill="var(--color-fabric-red, #c44)"
				opacity="0.06"
			/>

			{/* Plot frame */}
			<rect
				x={M.left}
				y={M.top}
				width={PLOT_W}
				height={PLOT_H}
				fill="none"
				stroke="var(--color-primary)"
				strokeWidth="1"
			/>

			{/* Quadrant divider lines at the data median */}
			<line
				x1={xMidPx}
				y1={M.top}
				x2={xMidPx}
				y2={M.top + PLOT_H}
				stroke="var(--color-primary)"
				strokeOpacity="0.3"
				strokeDasharray="2 3"
			/>
			<line
				x1={M.left}
				y1={yMidPx}
				x2={M.left + PLOT_W}
				y2={yMidPx}
				stroke="var(--color-primary)"
				strokeOpacity="0.3"
				strokeDasharray="2 3"
			/>

			{/* Quadrant labels */}
			<QuadrantLabel
				x={M.left + (xMidPx - M.left) / 2}
				y={M.top + (yMidPx - M.top) / 2}
				text="Volatile"
			/>
			<QuadrantLabel
				x={xMidPx + (M.left + PLOT_W - xMidPx) / 2}
				y={M.top + (yMidPx - M.top) / 2}
				text="Untrustworthy"
			/>
			<QuadrantLabel
				x={M.left + (xMidPx - M.left) / 2}
				y={yMidPx + (M.top + PLOT_H - yMidPx) / 2}
				text="Trustworthy"
			/>
			<QuadrantLabel
				x={xMidPx + (M.left + PLOT_W - xMidPx) / 2}
				y={yMidPx + (M.top + PLOT_H - yMidPx) / 2}
				text="Noisy"
			/>

			{/* Axes ticks: 0, midpoint, max. Minimal — the dots are the data. */}
			<AxisTick value={0} px={xToPx(0)} axis="x" unit={metric.unit} />
			<AxisTick value={xMid} px={xMidPx} axis="x" unit={metric.unit} />
			<AxisTick value={xMax} px={xToPx(xMax)} axis="x" unit={metric.unit} />
			<AxisTick value={0} px={yToPx(0)} axis="y" unit={metric.unit} />
			<AxisTick value={yMid} px={yMidPx} axis="y" unit={metric.unit} />
			<AxisTick value={yMax} px={yToPx(yMax)} axis="y" unit={metric.unit} />

			{/* Axis titles */}
			<text
				x={M.left + PLOT_W / 2}
				y={H - 12}
				textAnchor="middle"
				fontSize="12"
				fill="var(--color-secondary)"
			>
				{metric.xLabel}
			</text>
			<text
				transform={`translate(16, ${M.top + PLOT_H / 2}) rotate(-90)`}
				textAnchor="middle"
				fontSize="12"
				fill="var(--color-secondary)"
			>
				{metric.yLabel}
			</text>

			{/* Data points */}
			{points.map((p) => {
				const cx = xToPx(p.x);
				const cy = yToPx(p.y);
				const dim = p.sampleCount < MIN_SAMPLES;
				const color = providerColor(p.aggregator.toLowerCase());
				return (
					<g key={p.aggregator} opacity={dim ? 0.5 : 1}>
						<circle
							cx={cx}
							cy={cy}
							r={6}
							fill={color}
							stroke="var(--color-background)"
							strokeWidth="1.5"
						/>
						<text
							x={cx + 10}
							y={cy + 4}
							fontSize="11"
							fill="var(--color-primary)"
						>
							{formatProvider(p.aggregator.toLowerCase())}
							{dim ? ` (n=${p.sampleCount})` : ''}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

function QuadrantLabel({ x, y, text }: { x: number; y: number; text: string }) {
	return (
		<text
			x={x}
			y={y}
			textAnchor="middle"
			fontSize="11"
			fill="var(--color-secondary)"
			letterSpacing="0.5"
			style={{ textTransform: 'uppercase' }}
			opacity="0.5"
		>
			{text.toUpperCase()}
		</text>
	);
}

function AxisTick({
	value,
	px,
	axis,
	unit,
}: {
	value: number;
	px: number;
	axis: 'x' | 'y';
	unit: string;
}) {
	const label = `${value.toFixed(1)}${unit}`;
	if (axis === 'x') {
		return (
			<text
				x={px}
				y={M.top + PLOT_H + 16}
				textAnchor="middle"
				fontSize="10"
				fill="var(--color-secondary)"
			>
				{label}
			</text>
		);
	}
	return (
		<text
			x={M.left - 8}
			y={px + 3}
			textAnchor="end"
			fontSize="10"
			fill="var(--color-secondary)"
		>
			{label}
		</text>
	);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1]! + sorted[mid]!) / 2;
	}
	return sorted[mid]!;
}
