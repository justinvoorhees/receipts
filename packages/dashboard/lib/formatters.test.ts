import { describe, expect, it } from 'vitest';
import { formatProvider } from './formatters';

describe('formatProvider', () => {
	it('maps known aggregator slugs to their display name', () => {
		expect(formatProvider('fabric')).toBe('Fabric');
		expect(formatProvider('kyberswap')).toBe('KyberSwap');
	});

	it('truncates an unidentified aggregator\'s raw router address like a tx hash', () => {
		expect(formatProvider('0x77471234567890abcdef1234567890abcdef2359')).toBe('0x7747…2359');
	});

	it('passes through a short, non-address slug unchanged', () => {
		expect(formatProvider('unknown')).toBe('unknown');
	});
});
