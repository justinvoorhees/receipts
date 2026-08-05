import { describe, it, expect } from 'vitest';
import { maxStepDeviation, dispersionClause } from './priceDispersion';

describe('maxStepDeviation', () => {
	it('picks the larger of the two adjacent steps, normalized against At Block', () => {
		// before=35.0269, at=35.0232, after=35.0173
		// stepBeforeToAt = (35.0232-35.0269)/35.0232*10000 = -1.0565
		// stepAtToAfter  = (35.0173-35.0232)/35.0232*10000 = -1.6846  <- larger magnitude, wins
		const result = maxStepDeviation(35.0269, 35.0232, 35.0173);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-1.68, 2);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('picks Before->At when that step is larger, even though it is the earlier one', () => {
		// stepBeforeToAt = (35.00-35.10)/35.00*10000 = -28.57  <- larger magnitude, wins
		// stepAtToAfter  = 0
		const result = maxStepDeviation(35.10, 35.00, 35.00);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-28.57, 2);
		expect(result!.fromLabel).toBe('Before Block');
		expect(result!.toLabel).toBe('At Block');
	});

	it('reproduces the receipt-543 case: a static ruler with a real move after it', () => {
		// before === at (the ruler did not move — the common case), so the old
		// population-sigma formula diluted a real 3.96bps move down to a
		// reported 1.87bps. The max-step figure reports the real move.
		const before = 0.08946959294717734;
		const at = 0.08946959294717734;
		const after = 0.0895050535736239;
		const result = maxStepDeviation(before, at, after);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(3.96, 2);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('is exactly zero, defaulted to At->After, when the pool never moved', () => {
		// The COMMON case: the reference pool is usually not one the trade
		// touched, so all three blocks agree. This must render 0.00, not be
		// suppressed.
		const result = maxStepDeviation(35.0232, 35.0232, 35.0232);
		expect(result).not.toBeNull();
		expect(result!.bps).toBe(0);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('returns null when any block is missing, rather than narrowing the sample', () => {
		expect(maxStepDeviation(null, 35.0232, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, null, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, 35.0232, null)).toBeNull();
	});

	it('returns null for non-finite or non-positive input', () => {
		expect(maxStepDeviation(35.0269, 0, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, Number.NaN, 35.0173)).toBeNull();
		expect(maxStepDeviation('abc', 35.0232, 35.0173)).toBeNull();
	});

	it('accepts numeric strings, since the DB returns numerics as strings', () => {
		const result = maxStepDeviation('35.0269', '35.0232', '35.0173');
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-1.68, 2);
	});
});

describe('dispersionClause', () => {
	it('renders the winning step, signed, with two decimals and a trailing period', () => {
		expect(dispersionClause(35.0269, 35.0232, 35.0173)).toBe(
			'Price moved -1.68bps from At Block to After Block.',
		);
	});

	it('renders a positive step with a leading +', () => {
		expect(
			dispersionClause(0.08946959294717734, 0.08946959294717734, 0.0895050535736239),
		).toBe('Price moved +3.96bps from At Block to After Block.');
	});

	it('renders the zero case rather than omitting it, without a sign', () => {
		expect(dispersionClause(35.0232, 35.0232, 35.0232)).toBe(
			'Price moved 0.00bps from At Block to After Block.',
		);
	});

	it('is empty when the triple is incomplete', () => {
		expect(dispersionClause(null, 35.0232, 35.0173)).toBe('');
	});
});
