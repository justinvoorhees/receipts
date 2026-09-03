import { describe, expect, it } from 'vitest';
import { classifyRange } from './finality.js';

describe('classifyRange', () => {
	it('admits a range entirely at or below the finalized head', () => {
		expect(classifyRange(50831209, 50831209, false)).toBe('finalized');
		expect(classifyRange(50831000, 50831209, false)).toBe('finalized');
	});

	it('refuses a range above the finalized head by default', () => {
		expect(() => classifyRange(50831210, 50831209, false)).toThrow(/--allow-unfinalized/);
	});

	it('names the exact overshoot so the caller can just move the range back', () => {
		expect(() => classifyRange(50831500, 50831209, false)).toThrow(/291 block/);
	});

	it('permits an unfinalized range only when explicitly allowed, and marks it', () => {
		expect(classifyRange(50831210, 50831209, true)).toBe('unsafe');
	});
});
