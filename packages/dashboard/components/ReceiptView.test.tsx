import { describe, expect, it } from 'vitest';

describe('formatDelta', () => {
	it('returns the absolute dollar difference between market and execution price', async () => {
		const { formatDelta } = await import('./ReceiptView');
		// Figma example: market 1830.44284125, realized 1829.763683289442 → $0.68
		expect(formatDelta(1830.44284125, 1829.763683289442)).toBe('$0.68');
	});

	it('returns the same value when realized > market', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(1829.00, 1830.00)).toBe('$1.00');
	});

	it('returns – for null inputs', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(null, 1829.0)).toBe('–');
		expect(formatDelta(1830.0, null)).toBe('–');
	});
});
