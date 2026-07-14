import { describe, expect, it } from 'vitest';

// Quarantined "was this a good trade" helpers — not wired into ReceiptView.
// See qualityNotionals.ts for why they are kept.

describe('per-side notionals (Phase 1: both-or-none)', () => {
	it('isAnchorable is true for stablecoins and ETH/WETH, false otherwise', async () => {
		const { isAnchorable } = await import('./qualityNotionals');
		expect(isAnchorable('USDC')).toBe(true);
		expect(isAnchorable('DAI')).toBe(true);
		expect(isAnchorable('WETH')).toBe(true);
		expect(isAnchorable('ETH')).toBe(true);
		expect(isAnchorable('WBTC')).toBe(false);
		expect(isAnchorable('GITLAWB')).toBe(false);
	});

	it('values both sides at their mid USD price for a double-anchored pair', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		// USDC->WETH, mid 2000 USDC/WETH; received 0.51 WETH for 1000 USDC (beat mid).
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.51', marketMid: '2000',
		} as never);
		expect(n.notionalIn).toBe(1000);   // 1000 USDC x $1
		expect(n.notionalOut).toBe(1020);  // 0.51 WETH x 2000
	});

	it('returns both-null for a single-anchored pair (no second anchor in Phase 1)', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		// ETH->WBTC: WBTC not anchorable -> both null (never split)
		const n = perSideNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.028', marketMid: '35',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null for a no-anchor pair', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		const n = perSideNotionals({
			inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
			inputAmount: '6745937.5', outputAmount: '7234145.96', marketMid: '1.1016',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null when an ether side has no mid to value it', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.5', marketMid: null,
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});
});

describe('formatExecutionResult', () => {
	it('formats a positive result as +$ in green', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(20)).toEqual({ text: '+$20.00', color: '#117d45' });
	});
	it('formats a negative result as -$ with default color', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(-10)).toEqual({ text: '-$10.00', color: undefined });
	});
	it('formats an exact-zero result as $0.00', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(0)).toEqual({ text: '$0.00', color: undefined });
	});
});

describe('outputTokenDelta (no-anchor Price Delta)', () => {
	it('is the output-token difference vs marking at mid', async () => {
		const { outputTokenDelta } = await import('./qualityNotionals');
		// 7,234,145.96 - 6,745,937.5 x 1.1016 = -197,178.79
		const d = outputTokenDelta({
			inputAmount: '6745937.5', outputAmount: '7234145.96',
			marketMid: '1.1016', realizedPrice: '1.0724',
		} as never);
		expect(d).toBeCloseTo(-197178.79, 1);
	});
	it('is null when there is no mid', async () => {
		const { outputTokenDelta } = await import('./qualityNotionals');
		expect(outputTokenDelta({ inputAmount: '1', outputAmount: '2', marketMid: null, realizedPrice: null } as never)).toBeNull();
	});
});

describe('singleAnchorNotionals (Phase 2a)', () => {
	it('values the non-anchored side at mid for an ETH-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		// ETH->WBTC (real row): ETH anchored, WBTC marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
			marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(1791.14, 1);  // ETH = stored notional
		expect(n?.notionalOut).toBeCloseTo(1795.71, 1); // WBTC valued at mid
	});

	it('values the non-anchored side at mid for a stable-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		// CLAWD->USDC: USDC anchored (output face), CLAWD marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'CLAWD', outputSymbol: 'USDC',
			inputAmount: '1000', outputAmount: '50', notionalUsd: '50',
			marketMid: '0.052', realizedPrice: '0.05',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(52, 6);   // 1000 CLAWD x 0.052
		expect(n?.notionalOut).toBeCloseTo(50, 6);  // USDC face
	});

	it('returns null for double-anchor and no-anchor pairs', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		expect(singleAnchorNotionals({ inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '2000', realizedPrice: '2000' } as never)).toBeNull();
		expect(singleAnchorNotionals({ inputSymbol: 'LFI', outputSymbol: 'GITLAWB', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '1', realizedPrice: '1' } as never)).toBeNull();
	});
});

describe('independent oracle anchor (Phase 2 WBTC)', () => {
	it('values the non-anchored side at anchorPriceUsd when present (independent, any tier)', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		const n = singleAnchorNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
			marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
			anchorPriceUsd: '62000',
		} as never);
		expect(n?.independent).toBe(true);
		expect(n?.notionalIn).toBeCloseTo(1791.14, 1);
		expect(n?.notionalOut).toBeCloseTo(0.02862539 * 62000, 4); // 1774.77
	});
});
