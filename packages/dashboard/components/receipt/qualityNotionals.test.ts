import { describe, expect, it } from 'vitest';
import { receiptDollars } from './qualityNotionals';

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

const WETH = '0x4200000000000000000000000000000000000006';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TKN  = '0x1111111111111111111111111111111111111111';
const TKB  = '0x2222222222222222222222222222222222222222';

describe('receiptDollars (single ruler, display-orientation aware)', () => {
	it('base-is-output, input-anchored (ETH->WBTC): un-inverts stored mid, reports a GAIN', () => {
		// Stored DISPLAY mid = 35.0232 ETH-per-WBTC (core inverted the 0.0285525 output-per-input
		// because baseIsOutput). notionalUsd = 1791.14 = notionalIn. A naive impl (no un-invert)
		// would compute a LOSS here.
		const d = receiptDollars({ inputToken: WETH, outputToken: WBTC, inputAmount: '1', outputAmount: '0.028625', marketMid: '35.0232', notionalUsd: '1791.14' })!;
		expect(d.notionalIn).toBeCloseTo(1791.14, 2);
		expect(d.execResultUsd).toBeGreaterThan(4);
		expect(d.execResultUsd).toBeLessThan(5);
		expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
	});

	it('base-is-input, output-anchored (TKN->USDC): mid stored as-is; feeds derived notionalIn', () => {
		// baseIsOutput=false (base=TKN=input) -> mid not inverted. midOPi=2, realizedOPi=1005/500=2.01.
		// notionalUsd = 1000 = notionalOut.
		const d = receiptDollars({ inputToken: TKN, outputToken: USDC, inputAmount: '500', outputAmount: '1005', marketMid: '2', notionalUsd: '1000' })!;
		expect(d.notionalOut).toBeCloseTo(1000, 6);
		expect(d.notionalIn).toBeCloseTo(1000 * 2 / 2.01, 6);
		expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
	});

	it('returns null when no side anchors or a required field is missing', () => {
		expect(receiptDollars({ inputToken: TKN, outputToken: TKB, inputAmount: '1', outputAmount: '1', marketMid: '1', notionalUsd: '1' })).toBeNull();
		expect(receiptDollars({ inputToken: WETH, outputToken: WBTC, inputAmount: '1', outputAmount: '0.028625', marketMid: null, notionalUsd: '1791.14' })).toBeNull();
		expect(receiptDollars({ inputToken: WETH, outputToken: WBTC, inputAmount: '1', outputAmount: '0.028625', marketMid: '35.0232', notionalUsd: null })).toBeNull();
	});
});
