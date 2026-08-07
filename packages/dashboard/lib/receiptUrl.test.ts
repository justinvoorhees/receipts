import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAIN } from './chains';
import { legacyReceiptRedirect, receiptPath, resolveReceiptUrl, resolveSearchSubmission } from './receiptUrl';

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

describe('receiptPath', () => {
	it('builds the canonical path and lowercases the hash', () => {
		expect(receiptPath(DEFAULT_CHAIN, HASH)).toBe(`/tx/base/${HASH}`);
		expect(receiptPath(DEFAULT_CHAIN, MIXED)).toBe(`/tx/base/${HASH}`);
	});

	// Callers hand this raw user input (a pasted value that was never validated),
	// so a segment that could break out of the path must not.
	it('escapes a segment that is not a hash', () => {
		expect(receiptPath(DEFAULT_CHAIN, 'a/b?c')).toBe('/tx/base/a%2Fb%3Fc');
	});
});

describe('resolveReceiptUrl', () => {
	it('renders a fully canonical URL', () => {
		expect(resolveReceiptUrl('base', HASH)).toEqual({
			kind: 'render',
			chain: DEFAULT_CHAIN,
			hash: HASH,
		});
	});

	it('redirects a mixed-case hash', () => {
		expect(resolveReceiptUrl('base', MIXED)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	it('redirects the numeric chain alias', () => {
		expect(resolveReceiptUrl('8453', HASH)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	it('redirects a mis-cased slug', () => {
		expect(resolveReceiptUrl('BASE', HASH)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	// The whole point of resolving chain and hash together: a request wrong on
	// BOTH axes reaches the canonical URL in one hop, not two.
	it('corrects chain alias and hash casing in a SINGLE hop', () => {
		const result = resolveReceiptUrl('8453', MIXED);
		expect(result).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
		// Feeding the target back in must render, not redirect again.
		expect(resolveReceiptUrl('base', HASH).kind).toBe('render');
	});

	it('404s an unregistered chain', () => {
		expect(resolveReceiptUrl('arbitrum', HASH)).toEqual({ kind: 'notFound' });
	});

	it.each([
		['too short', '0x' + 'a'.repeat(63)],
		['too long', '0x' + 'a'.repeat(65)],
		['not hex', '0x' + 'z'.repeat(64)],
		['no 0x prefix', 'a'.repeat(64)],
		['empty', ''],
	])('404s a malformed hash (%s)', (_label, bad) => {
		expect(resolveReceiptUrl('base', bad)).toEqual({ kind: 'notFound' });
	});

	// Chain is checked first, so a request wrong on both axes costs one lookup.
	it('404s when both segments are bad', () => {
		expect(resolveReceiptUrl('arbitrum', 'nonsense')).toEqual({ kind: 'notFound' });
	});
});

describe('legacyReceiptRedirect', () => {
	it('sends a legacy ?tx= link to the default chain', () => {
		expect(legacyReceiptRedirect(HASH)).toBe(`/tx/base/${HASH}`);
	});

	it('lowercases and trims', () => {
		expect(legacyReceiptRedirect(`  ${MIXED}  `)).toBe(`/tx/base/${HASH}`);
	});

	// Redirecting garbage would turn a soft empty-search state into a hard 404.
	it('returns null for a malformed hash rather than redirecting to a 404', () => {
		expect(legacyReceiptRedirect('nonsense')).toBeNull();
		expect(legacyReceiptRedirect('')).toBeNull();
	});
});

describe('resolveSearchSubmission', () => {
	it('navigates a valid lowercase hash to the canonical path', () => {
		expect(resolveSearchSubmission(HASH)).toEqual({ kind: 'navigate', to: `/tx/base/${HASH}` });
	});

	it('navigates a valid mixed-case hash to the LOWERCASED path', () => {
		expect(resolveSearchSubmission(MIXED)).toEqual({ kind: 'navigate', to: `/tx/base/${HASH}` });
	});

	it('treats an empty string as empty', () => {
		expect(resolveSearchSubmission('')).toEqual({ kind: 'empty' });
	});

	it('treats whitespace-only input as empty', () => {
		expect(resolveSearchSubmission('   ')).toEqual({ kind: 'empty' });
	});

	// These are exactly the shapes a real user pastes into the box — a bad
	// paste must surface the inline FailureNotice, not a bare 404 (Finding 1).
	it.each([
		['too short', '0x' + 'a'.repeat(63)],
		['not hex', '0x' + 'z'.repeat(64)],
		['bare token address', '0x' + 'a'.repeat(40)],
		['a full Basescan URL', `https://basescan.org/tx/${HASH}`],
	])('flags %s as invalid', (_label, bad) => {
		expect(resolveSearchSubmission(bad)).toEqual({ kind: 'invalid' });
	});
});
