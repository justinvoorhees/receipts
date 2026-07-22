import { describe, expect, it } from 'vitest';
import { isCuratedMaker } from './makerRegistry.js';

describe('isCuratedMaker', () => {
	it('is true for the curated maker address, case-insensitively', () => {
		expect(isCuratedMaker('0x3dbe077e7986657e95e1cc50089f17a5a4af0aae')).toBe(true);
		expect(isCuratedMaker('0x3DBE077E7986657E95E1CC50089F17A5A4AF0AAE')).toBe(true);
	});
	it('is false for an address not on the list', () => {
		expect(isCuratedMaker('0x0000000000000000000000000000000000000001')).toBe(false);
	});
});
