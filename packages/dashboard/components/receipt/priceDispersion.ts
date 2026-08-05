/**
 * Largest single-block price move among the three adjacent blocks the
 * receipt shows (N-2 / N-1 / N), reported as a signed bps step between the
 * two blocks it spans.
 *
 * Deliberately the max of the two adjacent steps, not a population sigma
 * over all three: the reference pool is usually not one the trade touched,
 * so in the common case `before === at` (the ruler didn't move) and a sigma
 * dilutes a real single-block move — a 3.96bps step reported as 1.87bps is
 * not a mistake a reader can catch, because the three price cells above
 * this caption render at 3 significant figures and look identical either
 * way. The max step is one real observed delta, and unlike a sigma it can
 * carry a sign (which direction the market moved) and name which two
 * blocks moved.
 *
 * Deliberately returns null rather than a narrowed sample when a block is
 * missing: two points would render just like three could, so the reader
 * cannot tell them apart. Absent is not a smaller measurement.
 *
 * Expect 0.00 often. The reference pool is the deepest pool for the pair,
 * which usually is not a pool the trade touched, so in a 20-receipt sample
 * it was unchanged across all three blocks 15 times. Three identical rows
 * and a 0.00 clause are the intended output, not a bug.
 */

// Mirrors MarketPriceTable's row labels (receiptRows.tsx) so this clause can
// name the pair that moved without the two ever drifting apart. Owned here
// (the pure/logic module) and imported by receiptRows.tsx (the presentational
// consumer), not the other way around.
export const MARKET_PRICE_BLOCK_LABELS = ['Before Block', 'At Block', 'After Block'] as const;
const [BEFORE_LABEL, AT_LABEL, AFTER_LABEL] = MARKET_PRICE_BLOCK_LABELS;

function toFinitePositive(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export interface MaxStepDeviation {
	bps: number;
	fromLabel: string;
	toLabel: string;
}

export function maxStepDeviation(before: unknown, at: unknown, after: unknown): MaxStepDeviation | null {
	const b = toFinitePositive(before);
	const a = toFinitePositive(at);
	const f = toFinitePositive(after);
	if (b === null || a === null || f === null) return null;

	// Both steps normalized against `at` (the ruler) — the same denominator
	// the rest of the receipt's bps figures use, so this number stays
	// comparable to them.
	const stepBeforeToAt = ((a - b) / a) * 10_000;
	const stepAtToAfter = ((f - a) / a) * 10_000;

	// Ties (including the common all-three-equal case) default to the
	// At->After step: it's the step closer to trade execution.
	if (Math.abs(stepAtToAfter) >= Math.abs(stepBeforeToAt)) {
		return { bps: stepAtToAfter, fromLabel: AT_LABEL, toLabel: AFTER_LABEL };
	}
	return { bps: stepBeforeToAt, fromLabel: BEFORE_LABEL, toLabel: AT_LABEL };
}

export function dispersionClause(before: unknown, at: unknown, after: unknown): string {
	const step = maxStepDeviation(before, at, after);
	if (step === null) return '';
	const rounded = Number(step.bps.toFixed(2));
	const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
	return `Price moved ${sign}${Math.abs(rounded).toFixed(2)}bps from ${step.fromLabel} to ${step.toLabel}.`;
}
