import { describe, it, expect } from 'vitest';
import { clampPagination, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';

describe('clampPagination', () => {
	it('defaults to the first page at the default size', () => {
		expect(clampPagination({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0, page: 1 });
	});

	it('computes the offset from the page number', () => {
		expect(clampPagination({ page: '3' }).offset).toBe(2 * DEFAULT_PAGE_SIZE);
	});

	// `?size=100000` would otherwise pull the whole table into memory and ship it
	// to the client — the exact query that gets worse the more the table is spammed.
	it('caps an oversized page size', () => {
		expect(clampPagination({ size: '100000' }).limit).toBe(MAX_PAGE_SIZE);
	});

	it('rejects a zero or negative page size', () => {
		expect(clampPagination({ size: '0' }).limit).toBe(DEFAULT_PAGE_SIZE);
		expect(clampPagination({ size: '-5' }).limit).toBe(DEFAULT_PAGE_SIZE);
	});

	it('rejects a zero or negative page number', () => {
		expect(clampPagination({ page: '0' }).page).toBe(1);
		expect(clampPagination({ page: '-3' }).page).toBe(1);
		expect(clampPagination({ page: '-3' }).offset).toBe(0);
	});

	it.each(['abc', '', '1e9', 'NaN', '1.5', 'Infinity'])(
		'falls back to defaults for a non-integer page (%s)',
		(page) => {
			expect(clampPagination({ page })).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0, page: 1 });
		},
	);

	// A huge page number is not an error, but the offset it implies must stay a
	// sane integer rather than overflowing into a malformed query.
	it('keeps the offset finite for an absurd page number', () => {
		const { offset } = clampPagination({ page: '999999999' });
		expect(Number.isSafeInteger(offset)).toBe(true);
		expect(offset).toBeGreaterThanOrEqual(0);
	});

	it('accepts a valid explicit size', () => {
		expect(clampPagination({ size: '25' }).limit).toBe(25);
	});
});
