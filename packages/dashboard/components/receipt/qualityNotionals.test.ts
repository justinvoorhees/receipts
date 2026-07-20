import { describe, expect, it } from 'vitest';
import { receiptDollars, formatExecutionResult } from './qualityNotionals';

describe('isAnchorable', () => {
	it('is true for stablecoins and ETH/WETH, false otherwise', async () => {
		const { isAnchorable } = await import('./qualityNotionals');
		expect(isAnchorable('USDC')).toBe(true);
		expect(isAnchorable('DAI')).toBe(true);
		expect(isAnchorable('WETH')).toBe(true);
		expect(isAnchorable('ETH')).toBe(true);
		expect(isAnchorable('WBTC')).toBe(false);
		expect(isAnchorable('GITLAWB')).toBe(false);
	});
});

describe('formatExecutionResult', () => {
	it('formats a positive result as unsigned $ in green with Gained sub', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(20)).toEqual({ text: '$20.00', sub: 'Gained', color: '#117d45' });
	});
	it('formats a negative result as unsigned $ with default color and Lost sub', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(-10)).toEqual({ text: '$10.00', sub: 'Lost', color: undefined });
	});
	it('formats an exact-zero result as $0.00 with no sub', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(0)).toEqual({ text: '$0.00', sub: null, color: undefined });
	});
});

describe('receiptDollars (single ruler)', () => {
	// Reference ETH->WBTC: 1 ETH -> 0.028625 WBTC, marketMid 1/35.0232 (WBTC per ETH),
	// input (ETH) anchored, notionalUsd = 1791.14 = notionalIn.
	const base = {
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputAmount: '1', outputAmount: '0.028625',
		marketMid: String(1 / 35.0232), realizedPrice: String(0.028625 / 1),
		notionalUsd: '1791.14',
	};

	it('input-anchored: notionalIn = notionalUsd, execResult = notionalOut - notionalIn (~+$4.5)', () => {
		const d = receiptDollars(base)!;
		expect(d.notionalIn).toBeCloseTo(1791.14, 2);
		expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
		expect(d.execResultUsd).toBeGreaterThan(4);
		expect(d.execResultUsd).toBeLessThan(5);
	});

	it('output-anchored: feeds reconciledResult the derived notionalIn, not notionalUsd', () => {
		// TOKEN -> USDC, USDC (output) anchored. notionalUsd = notionalOut = 1000.
		// marketMid = 2 (USDC per TOKEN), realized = 2.01 (got slightly more USDC).
		const d = receiptDollars({
			inputSymbol: 'TKN', outputSymbol: 'USDC',
			inputAmount: '500', outputAmount: '1005',
			marketMid: '2', realizedPrice: '2.01', notionalUsd: '1000',
		})!;
		expect(d.notionalOut).toBeCloseTo(1000, 6);
		// notionalIn = notionalUsd * mid/realized = 1000 * 2/2.01
		expect(d.notionalIn).toBeCloseTo(1000 * 2 / 2.01, 6);
		expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
	});

	it('returns null when no side anchors or a field is missing', () => {
		expect(receiptDollars({ ...base, inputSymbol: 'TKA', outputSymbol: 'TKB' })).toBeNull();
		expect(receiptDollars({ ...base, marketMid: null })).toBeNull();
		expect(receiptDollars({ ...base, notionalUsd: null })).toBeNull();
	});
});

describe('formatExecutionResult (unsigned)', () => {
	it('positive => magnitude only + Gained + green (no + sign)', () => {
		const r = formatExecutionResult(4.57);
		expect(r.text).toBe('$4.57');
		expect(r.text).not.toContain('+');
		expect(r.sub).toBe('Gained');
		expect(r.color).toBe('#117d45');
	});
	it('negative => magnitude only + Lost + default color (no - sign)', () => {
		const r = formatExecutionResult(-3.2);
		expect(r.text).toBe('$3.20');
		expect(r.text).not.toContain('-');
		expect(r.sub).toBe('Lost');
		expect(r.color).toBeUndefined();
	});
	it('zero => no direction', () => {
		expect(formatExecutionResult(0).sub).toBeNull();
	});
});
