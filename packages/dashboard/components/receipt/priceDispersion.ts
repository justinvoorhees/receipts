/**
 * Dispersion of the reference pool's mid across the three adjacent blocks the
 * receipt shows (N-2 / N-1 / N).
 *
 * Deliberately returns null rather than a narrowed sample when a block is
 * missing: a sigma over two points renders identically to one over three, so
 * the reader cannot tell them apart. Absent is not a smaller measurement.
 *
 * Expect 0.00 often. The reference pool is the deepest pool for the pair, which
 * usually is not a pool the trade touched, so in a 20-receipt sample it was
 * unchanged across all three blocks 15 times. Three identical rows and a 0.00
 * clause are the intended output, not a bug.
 */
function toFinitePositive(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function dispersionBps(before: unknown, at: unknown, after: unknown): number | null {
	const b = toFinitePositive(before);
	const a = toFinitePositive(at);
	const f = toFinitePositive(after);
	if (b === null || a === null || f === null) return null;

	const mean = (b + a + f) / 3;
	const variance = ((b - mean) ** 2 + (a - mean) ** 2 + (f - mean) ** 2) / 3;
	// Expressed against the At Block mid — the ruler — not the mean, so the
	// figure is relative to the number the rest of the receipt is measured from.
	return (Math.sqrt(variance) / a) * 10_000;
}

export function dispersionClause(before: unknown, at: unknown, after: unknown): string {
	const bps = dispersionBps(before, at, after);
	return bps === null ? '' : `Price deviates ${bps.toFixed(2)}bps between blocks.`;
}
