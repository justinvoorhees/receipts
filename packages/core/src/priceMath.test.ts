import { describe, it, expect } from 'vitest';
import { isImplausibleDeviationBps, IMPLAUSIBLE_DEVIATION_CAP_BPS } from './priceMath.js';

describe('isImplausibleDeviationBps', () => {
	it('is false for null (no mid → no deviation to judge)', () => {
		expect(isImplausibleDeviationBps(null)).toBe(false);
	});

	it('is false for plausible costs — even a very bad real trade', () => {
		expect(isImplausibleDeviationBps(408)).toBe(false); // CLAWNCH after the mid fix
		expect(isImplausibleDeviationBps(-5000)).toBe(false); // 50% off — bad but real
		expect(isImplausibleDeviationBps(IMPLAUSIBLE_DEVIATION_CAP_BPS)).toBe(false); // at the cap
	});

	it('is true beyond the cap — a garbage reference mid, not a real execution', () => {
		expect(isImplausibleDeviationBps(IMPLAUSIBLE_DEVIATION_CAP_BPS + 1)).toBe(true);
		expect(isImplausibleDeviationBps(2.5778884514622366e25)).toBe(true); // the CLAWNCH garbage value
		expect(isImplausibleDeviationBps(-2.5778884514622366e25)).toBe(true);
	});
});
