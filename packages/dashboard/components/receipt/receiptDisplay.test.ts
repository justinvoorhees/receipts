import { describe, it, expect } from 'vitest';
import { getAggregatorFeeLines } from './receiptDisplay';

const BASE = 'https://basescan.org/address/';

describe('getAggregatorFeeLines', () => {
	it('single named sink uses the verbatim name', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 93.5, feeRecipient: '0x0847',
			feeSinks: [{ address: '0x0847', feeBps: 93.5, source: 'retained_balance', name: 'PoolFees' }],
		});
		expect(lines).toEqual([{ label: 'PoolFees', href: BASE + '0x0847', bps: 93.5 }]);
	});

	it('single unnamed sink renders its truncated address, naming no party', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 19.02, feeRecipient: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae',
			feeSinks: [{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null }],
		});
		expect(lines).toEqual([
			{ label: '0x3dbe…0aae', href: BASE + '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', bps: 19.02 },
		]);
	});

	// The label must be a function of the SINK, never of the aggregator in front
	// of it. 0x3dbe…0aae is an RFQ maker that fills for several routers; the old
	// dominant-sink fallback called it "Nordstern Fee" on receipt 53 and "Velora
	// Fee" on 208/210. Same address, same money, two different accusations.
	it('gives one sink one label regardless of which aggregator routed to it', () => {
		const sink = { address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null };
		const nordstern = getAggregatorFeeLines({ aggFeeBps: 19.02, feeSinks: [{ ...sink }] });
		const velora = getAggregatorFeeLines({ aggFeeBps: 19.02, feeSinks: [{ ...sink }] });
		expect(nordstern[0]!.label).toBe('0x3dbe…0aae');
		expect(velora[0]!.label).toBe(nordstern[0]!.label);
	});

	it('multiple sinks: a named subsequent sink uses its name', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: 'Vault' },
			],
		});
		expect(lines[0]!.label).toBe('0x3dbe…0aae');
		expect(lines[1]!.label).toBe('Vault');
		expect(lines[1]!.href).toBe(BASE + '0x5f6900000000000000000000000000000000d431');
	});

	it('multiple sinks: an UNNAMED subsequent sink stays a truncated address', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x3912760000000000000000000000000000d24600', feeBps: 2.98, source: 'retained_balance', name: null },
			],
		});
		expect(lines[0]!.label).toBe('0x3dbe…0aae');
		expect(lines[1]!.label).toBe('0x3912…4600'); // curation cue survives for genuinely unknown sinks
	});

	it('Clanker derivatives on receipt 371 render as three distinct labels', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 10.901872046818054,
			feeSinks: [
				{ address: '0xad01c20d5886137e056775af56915de824c8fce5', feeBps: 5.001914524202447, source: 'retained_balance', name: null },
				{ address: '0xf3622742b1e446d92e45e22923ef11c2fcd55d68', feeBps: 4.916631268846352, source: 'retained_balance', name: 'ClankerFeeLocker' },
				{ address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', feeBps: 0.9833262537692553, source: 'retained_balance', name: 'Clanker' },
			],
		});
		expect(lines.map(l => l.label)).toEqual(['0xad01…fce5', 'ClankerFeeLocker', 'Clanker']);
		expect(lines[1]!.href).toBe(BASE + '0xf3622742b1e446d92e45e22923ef11c2fcd55d68');
		expect(lines[2]!.href).toBe(BASE + '0xe85a59c628f7d27878aceb4bf3b35733630083a9');
	});

	it('a curated MANUAL_OVERRIDES name wins, as on receipt 328s Relay vault_map sink', () => {
		const lines = getAggregatorFeeLines({
			aggFeeBps: 15.92,
			feeSinks: [{ address: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', feeBps: 15.92, source: 'vault_map', name: 'Relay: Solver' }],
		});
		expect(lines[0]!.label).toBe('Relay: Solver');
		expect(lines[0]!.href).toBe(BASE + '0xf70da97812cb96acdf810712aa562db8dfa3dbef');
	});

	it('legacy row (no feeSinks) falls back to a linked feeRecipient address', () => {
		const lines = getAggregatorFeeLines({ aggFeeBps: 1.95, feeRecipient: '0x7d94baf661d5ed8ad30d7241d1a50f3883083ef7' });
		expect(lines).toEqual([
			{ label: '0x7d94…3ef7', href: BASE + '0x7d94baf661d5ed8ad30d7241d1a50f3883083ef7', bps: 1.95 },
		]);
	});

	it('emits no line when a fee has no recipient at all', () => {
		expect(getAggregatorFeeLines({ aggFeeBps: 12.5, feeSinks: [] })).toEqual([]);
	});

	it('returns [] when there is no fee', () => {
		expect(getAggregatorFeeLines({ aggFeeBps: 0 })).toEqual([]);
		expect(getAggregatorFeeLines({ aggFeeBps: null })).toEqual([]);
	});
});

describe('getExecutionBreakdown coverage gating', () => {
	// The REAL persisted row for receipt id 210 (Velora, $13,094), copied from
	// the database: 7 legs = 1 wrap (excluded from coverage) + 6 costed, of
	// which the rfq leg is unpriced. Coverage 76.5480%; Σ legPI 19.36871009…;
	// residual 25.544581… − 19.368710… = 6.175871… → renders "6.18bps".
	const SLIPPAGE_BPS = 25.544581236341276;
	const SUM_PI = 19.36871009070179;
	const id210 = {
		slippageBps: SLIPPAGE_BPS,
		routeLegs: [
			{ type: 'wrap', notionalUsdc: 0, priceImpactBps: null },
			{ type: 'rfq', notionalUsdc: 4971.412665, priceImpactBps: null },
			{ type: 'aerodrome_cl', notionalUsdc: 262.18974219197634, priceImpactBps: 0.020898202205538393 },
			{ type: 'univ3', notionalUsdc: 3665.7859929998917, priceImpactBps: 0.09839290965261527 },
			{ type: 'univ3', notionalUsdc: 1047.1355028719797, priceImpactBps: 0.03968021578582681 },
			{ type: 'pancakev3', notionalUsdc: 3142.2182415639018, priceImpactBps: 0.026166874292076724 },
			{ type: 'curve_stableng', notionalUsdc: 8109.494037, priceImpactBps: 19.183571888765734 },
		],
	};
	// Same trade, same residual, but collapsed to a single fully-priced leg —
	// so the two fixtures differ ONLY in coverage, and any display difference
	// between them is attributable to the gate and nothing else.
	const fullyPricedRow = {
		slippageBps: SLIPPAGE_BPS,
		routeLegs: [{ type: 'univ3', notionalUsdc: 13094.06, priceImpactBps: SUM_PI }],
	};

	it('a partially-priced route moves its residual to Unattributed', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(id210 as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.slippageDisplay.text).toBe('N/A');
		expect(r.positiveSlippageDisplay.text).toBe('N/A');
		expect(r.unattributedDisplay.text).toBe('6.18bps');
		// Unnegated and signed — the display string above has lost both.
		// 25.544581236341276 − 19.36871009070179 = 6.175871145639486, which
		// formatDialogBps then rounds to the "6.18bps" asserted above.
		expect(r.residualRawBps).toBeCloseTo(6.175871145639486, 9);
	});

	it('THE REGRESSION GUARD: Unattributed prints exactly what Slippage used to', async () => {
		// This change must not move a single digit. Before this work, id 210's
		// Slippage row rendered "6.18bps" — the SAME residual, under a name that
		// claimed we had accounted for price impact. Only the label changes.
		const { getExecutionBreakdown, formatDialogBps } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(id210 as never);
		const sumPi = id210.routeLegs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0);
		const legacySlippage = formatDialogBps(-(id210.slippageBps - sumPi));
		expect(r.unattributedDisplay.text).toBe(legacySlippage.text);
	});

	it('THE REGRESSION GUARD, BENEFIT SIGN: matches what Positive Slippage used to print', async () => {
		// The guard above only covers a residual that is a COST. When the residual
		// is a BENEFIT the old code populated positiveSlippageDisplay instead, and
		// that is a genuinely different branch — Math.min vs Math.max. Real row:
		// receipt id 236 (KyberSwap, $1,457), 6 legs = 1 wrap + 5 costed, of which
		// the rfq leg is unpriced. Residual −17.561717… − 1.379457… = −18.941175…,
		// which renders "+18.94bps" in green because formatDialogBps negates for
		// display, strips the sign, and prefixes '+' on a benefit.
		const { getExecutionBreakdown, formatDialogBps } = await import('./receiptDisplay');
		const id236 = {
			slippageBps: -17.56171729419208,
			routeLegs: [
				{ type: 'wrap', notionalUsdc: 0, priceImpactBps: null },
				{ type: 'univ4', notionalUsdc: 76.09571262441439, priceImpactBps: 0.338318289217868 },
				{ type: 'aerodrome_cl', notionalUsdc: 331.6565639769648, priceImpactBps: 0.5273604145160479 },
				{ type: 'univ3', notionalUsdc: 1049.423401227888, priceImpactBps: 0.4149244874839112 },
				{ type: 'aerodrome_cl', notionalUsdc: 1125.252255, priceImpactBps: 0.09885414605025682 },
				{ type: 'rfq', notionalUsdc: 1125.252255, priceImpactBps: null },
			],
		};
		const r = getExecutionBreakdown(id236 as never);
		expect(r.fullyPriced).toBe(false);

		// Derived the same way as the cost-sign guard, so it cannot be self-fulfilling.
		const sumPi = id236.routeLegs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0);
		const residual = id236.slippageBps - sumPi;
		expect(residual).toBeLessThan(0); // this test is worthless if the sign flips
		const legacyPositiveSlippage = formatDialogBps(-Math.min(residual, 0));
		expect(r.unattributedDisplay.text).toBe(legacyPositiveSlippage.text);
		expect(r.unattributedDisplay.color).toBe(legacyPositiveSlippage.color);

		// Pinned literally too — a bug that broke BOTH the code and the derivation
		// above would otherwise cancel out and pass.
		expect(r.unattributedDisplay.text).toBe('+18.94bps');
		expect(r.unattributedDisplay.color).toBe('#117d45');
	});

	it('a fully-priced route keeps Slippage and blanks Unattributed', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(fullyPricedRow as never);
		expect(r.fullyPriced).toBe(true);
		expect(r.unattributedDisplay.text).toBe('N/A');
		expect(r.slippageDisplay.text).toBe('6.18bps');
		expect(r.positiveSlippageDisplay.text).toBe('0.00bps');
		expect(r.coveragePercent).toBe(100);
	});

	it('coveragePercent floors, so it never overstates what we priced', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// 76.5480% must read 76, not 77.
		expect(getExecutionBreakdown(id210 as never).coveragePercent).toBe(76);
	});

	it('coveragePercent caps at 99 when a zero-notional leg is unpriced', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// Notional-weighted coverage is exactly 1, but the route is NOT fully
		// priced. "pricing coverage is 100% complete" beside an N/A is absurd.
		const r = getExecutionBreakdown({
			slippageBps: 10,
			routeLegs: [
				{ type: 'swap', notionalUsdc: 1000, priceImpactBps: 2 },
				{ type: 'swap', notionalUsdc: 0, priceImpactBps: null },
			],
		} as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.coveragePercent).toBe(99);
	});

	it('an empty route is 0% covered, not vacuously complete', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown({ slippageBps: 25.54, routeLegs: [] } as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.coveragePercent).toBe(0);
		expect(r.unattributedDisplay.text).toBe('25.54bps');
		expect(r.slippageDisplay.text).toBe('N/A');
	});

	// A market-maker fill has no on-chain mid to compare against — it is
	// unattributable BY DESIGN, not because our readers failed. Telling a trader
	// "pricing coverage is 0% complete" on such a receipt blames the tool for a
	// property of how RFQ works. Real split in the corpus: 10 receipts /$74,969
	// where every unpriced leg is a maker fill, vs 8 /$1,607 where none is.
	const makerLeg = { type: 'rfq', venue: '0x3dbe077e79b2a0e0b1f3a4c1e5d7a9c2b4e6f8a0', notionalUsdc: 1000, priceImpactBps: null };
	const poolLeg = (priceImpactBps: number | null) => ({
		type: 'univ3', venue: '0x1111111111111111111111111111111111111111',
		notionalUsdc: 1000, priceImpactBps,
	});

	it('names market-maker inventory when the WHOLE route is maker-filled', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// id 36's shape: a single maker fill, nothing else. 7 of 62 receipts.
		const r = getExecutionBreakdown({ slippageBps: 25.54, routeLegs: [makerLeg] } as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.slippageUnavailableTooltip).toBe('No calculation available due to market maker inventory.');
	});

	it('a MIXED pool+maker route reports coverage, not maker inventory', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// id 210's shape: one maker leg among six, 77% of the notional priced
		// through pools. "Every unpriced leg is a maker" is true here, and would
		// be the wrong test — claiming the whole trade was maker-filled when most
		// of it demonstrably was not. The coverage figure is more informative.
		const r = getExecutionBreakdown({
			slippageBps: 25.54,
			routeLegs: [poolLeg(4.19), poolLeg(2.11), makerLeg],
		} as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.slippageUnavailableTooltip).toContain('per-leg pricing coverage is');
		expect(r.slippageUnavailableTooltip).not.toContain('market maker');
	});

	it('falls back to the coverage wording when an unpriced leg is NOT a maker fill', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// A pool leg we simply failed to price is OUR gap, not the market's.
		const r = getExecutionBreakdown({
			slippageBps: 25.54,
			routeLegs: [poolLeg(4.19), poolLeg(null)],
		} as never);
		expect(r.slippageUnavailableTooltip).toBe(
			'No calculation available, per-leg pricing coverage is 50% complete',
		);
	});

	it('does not claim maker inventory when an unpriced POOL leg is present', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// A pool leg we simply failed to price is unambiguously our gap.
		const r = getExecutionBreakdown({
			slippageBps: 25.54,
			routeLegs: [poolLeg(4.19), makerLeg, poolLeg(null)],
		} as never);
		expect(r.slippageUnavailableTooltip).toContain('per-leg pricing coverage is');
	});

	it('a multi-leg route that is ALL maker still names maker inventory', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// The rule is "every costed leg is a maker", not "exactly one leg".
		const r = getExecutionBreakdown({
			slippageBps: 25.54,
			routeLegs: [makerLeg, { ...makerLeg, notionalUsdc: 500 }],
		} as never);
		expect(r.slippageUnavailableTooltip).toBe('No calculation available due to market maker inventory.');
	});

	it('offers no tooltip at all when the route is fully priced', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown({ slippageBps: 25.54, routeLegs: [poolLeg(19.37)] } as never);
		expect(r.fullyPriced).toBe(true);
		expect(r.slippageUnavailableTooltip).toBeUndefined();
	});

	it('an empty route is a coverage gap, not maker inventory', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// Vacuous truth trap: `[].every(isMaker)` is true. A route we never
		// decomposed is not evidence a market maker filled it.
		const r = getExecutionBreakdown({ slippageBps: 25.54, routeLegs: [] } as never);
		expect(r.slippageUnavailableTooltip).toContain('pricing coverage is 0% complete');
	});

	it('a null slippageBps yields N/A everywhere, not a fake zero', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown({ slippageBps: null, routeLegs: [] } as never);
		expect(r.unattributedDisplay.text).toBe('–');
		expect(r.slippageDisplay.text).toBe('N/A');
	});

	it('the N/A tooltip names the coverage percentage', async () => {
		const { noSlippageTooltip } = await import('./receiptDisplay');
		expect(noSlippageTooltip(76)).toBe(
			'No calculation available, per-leg pricing coverage is 76% complete',
		);
	});
});
