import { describe, expect, it } from 'vitest';
import { validateMid, MID_VALIDATION_TOL_BPS } from './validateMid.js';

// All corroborator prices must be pre-normalized to the same orientation as
// `spotMid` (quote-per-base). The pure function only compares magnitudes.
const C = (source: string, price: number | null) => ({ source, price });

describe('validateMid', () => {
	it('validates when a corroborator agrees within tolerance', () => {
		const r = validateMid(100, [C('twap', 100.5)]); // 50 bps < 100
		expect(r.validated).toBe(true);
		expect(r.agreeing).toEqual(['twap']);
	});

	it('does not validate when every corroborator deviates beyond tolerance', () => {
		const r = validateMid(100, [C('twap', 103), C('defillama', 97)]); // 300 / 309 bps
		expect(r.validated).toBe(false);
		expect(r.agreeing).toEqual([]);
	});

	it('validates on the tolerance boundary (<= TOL)', () => {
		// exactly 100 bps deviation vs the corroborator's own price
		const r = validateMid(101, [C('twap', 100)]); // (101-100)/100 = 100 bps
		expect(r.validated).toBe(true);
	});

	it('does not validate when no corroborator has a usable price', () => {
		const r = validateMid(100, [C('twap', null), C('defillama', 0), C('x', -5)]);
		expect(r.validated).toBe(false);
		expect(r.agreeing).toEqual([]);
	});

	it('does not validate with an empty corroborator list', () => {
		expect(validateMid(100, []).validated).toBe(false);
	});

	it('reports the closest deviation in bps', () => {
		const r = validateMid(100, [C('twap', 102), C('defillama', 100.3)]);
		expect(r.devBps).toBeCloseTo(30, 0); // closest corroborator = defillama, 30 bps
	});

	it('ignores a non-finite spot mid', () => {
		expect(validateMid(NaN, [C('twap', 100)]).validated).toBe(false);
		expect(validateMid(0, [C('twap', 100)]).validated).toBe(false);
	});

	it('exposes a 100 bps default tolerance', () => {
		expect(MID_VALIDATION_TOL_BPS).toBe(100);
	});
});
