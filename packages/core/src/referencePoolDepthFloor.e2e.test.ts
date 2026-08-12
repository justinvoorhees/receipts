/**
 * referencePoolDepthFloor.e2e.test.ts — the depth floor against the real chain.
 *
 * Every other test in this feature runs on fakes. These three are the ones that
 * would actually have caught the bug, and the ones that will catch its return.
 *
 * ⚠️ Skips SILENTLY without TCA_RPC_URL, and `source .env` does not export by
 * itself. Run with:  set -a && source .env && set +a && npx vitest run …
 * A "skipped" result here proves nothing.
 */
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const d = RPC ? describe : describe.skip;
const CHAIN = 8453;

d('reference-pool depth floor e2e', () => {
	// The positive-sign instance, and 41x the notional of the motivating tx —
	// this defect is not confined to trivially small trades. Its ruler is
	// 0x6945a4Bf holding $0.216, the SAME pool at byte-identical depth as the
	// spec's 0x537a3c55.
	it('floors the BEAN->ETH receipt and refuses to publish a delta', async () => {
		const r = await analyzeTransaction(
			'0x7e21b6dcc964e36ffb7921841d6c9bf00624dac086738843af561b7c7768b0ce', CHAIN, { rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();

		expect(r!.tier).toBe('none');
		expect(r!.marketMid).toBeNull();
		expect(r!.allInCostBps).toBeNull();
		expect(r!.slippageBps).toBeNull();
		expect(r!.marketPriceFlags).toContain('INSUFFICIENT_DEPTH');

		// The evidence, recorded on the receipt so the refusal can be audited.
		expect(r!.referenceDepthUsd).not.toBeNull();
		expect(r!.referenceDepthUsd!).toBeLessThan(1);
		expect(r!.referencePoolAddress!.toLowerCase()).toBe('0x6945a4bf3e7a68d86c4bfd863c6d664575d81545');
		expect(r!.methodology).toContain('deepest reference pool');
		// The copy reports the measured depth and never the threshold.
		expect(r!.methodology).not.toContain('minimum');

		// What the receipt KEEPS. Per-leg impact is measured against the leg's own
		// pool mid at N-1, so a floored ruler must not touch it.
		//
		// ~$81.56, off the anchored ETH side. Was ~$81.68 before the notional was
		// rewired onto the SAME ranked-and-floored WETH/USDC apparatus the ruler
		// uses (see notional-depth-gating Task 3): the ETH-side value used to come
		// from a first-match WETH/USDC pool that could differ from the ruler's
		// deepest one. weightedPriceImpactBps below normalizes by this whole-trade
		// notional, so its ~0.1bps/~0.15 lpFeeBps drift is that same unification,
		// not a new defect.
		expect(r!.notionalUsd).toBeGreaterThan(50);
		expect(r!.routeLegs!.length).toBeGreaterThan(0);
		const leg = r!.routeLegs![0] as { priceImpactBps: number | null; lpFeeBps: number | null };
		expect(leg.priceImpactBps).toBeCloseTo(61.23, 1);
		expect(leg.lpFeeBps).toBeCloseTo(110.02, 1);
	}, 120000);

	// ⚠️ The NEGATIVE-sign instance. Both dust pools OVERPRICE the memecoin, so
	// the sign is set purely by trade direction — this one reported a 170%
	// "windfall" (-16960.7bps). A test asserting a large POSITIVE delta passes on
	// every other case and misses this entire half of the population.
	it('floors the USDC->ClawBank receipt, the windfall-shaped instance', async () => {
		const r = await analyzeTransaction(
			'0x1955c578dab4a6dff4ca51e9bc5b7d164049868fb224dcd5aa32bb031365dcfa', CHAIN, { rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();

		expect(r!.tier).toBe('none');
		expect(r!.marketMid).toBeNull();
		expect(r!.allInCostBps).toBeNull();
		expect(r!.marketPriceFlags).toContain('INSUFFICIENT_DEPTH');
		expect(r!.referenceDepthUsd!).toBeLessThan(1);

		// Both legs keep their own price impact.
		const legs = r!.routeLegs as { priceImpactBps: number | null }[];
		expect(legs.length).toBe(2);
		expect(legs.every((l) => l.priceImpactBps != null)).toBe(true);
	}, 120000);

	/*
	  The regression that matters most: a receipt that still HAS a ruler must keep
	  it, and must not be described as if it did not.

	  This transaction is the mixed case and is worth more than a plain deep-pool
	  control: its DIRECT class is a $0.00006 pool that the floor rejects, while
	  its bridged class is healthy and sets the mid. It caught two defects on
	  2026-08-12 — the depth fields reporting the thrown-away pool, and
	  methodologyFor handing an "Unavailable" sentence to a priced receipt.
	*/
	it('keeps the surviving ruler when only one class is floored out', async () => {
		const r = await analyzeTransaction(
			'0x30cada4e7725849ed3ea3b6995cda425cc7dfbb82eb24d73c6285c18a3cb6357', CHAIN, { rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();

		// The mid survives, so the whole-trade delta survives with it.
		expect(r!.marketMid).not.toBeNull();
		expect(r!.allInCostBps).not.toBeNull();
		expect(r!.tier).not.toBe('none');

		// The rejection genuinely happened and is still reported — that IS the
		// signal "one of your two rulers was dust".
		expect(r!.marketPriceFlags).toContain('INSUFFICIENT_DEPTH');

		// But the depth fields must describe the ruler in use, not the rejected
		// pool, and the copy must not claim the price is unavailable.
		expect(r!.referenceDepthUsd!).toBeGreaterThan(100);
		expect(r!.methodology).not.toContain('Unavailable');
		expect(r!.methodology).not.toContain('No reliable market price');

		// Per-leg impact is untouched either way.
		const legs = r!.routeLegs as { priceImpactBps: number | null }[];
		expect(legs.some((l) => l.priceImpactBps != null)).toBe(true);
	}, 120000);

	/*
	  Not a floor case -- the ranking half of this change. Neither KEYCAT nor
	  AERO anchors, so before this change `bestEffortNotional` took the first
	  matching pool: a thin direct KEYCAT/USDC pool that overstated the trade
	  5.3x ($37,984.03). Ranked-and-floored discovery now prices through the
	  deepest KEYCAT/WETH pool instead: $7,153.36.

	  Trusted by cross-check against the receipt's OWN market mid, which this
	  change does not touch (marketMid stays 0.00082548 AERO per KEYCAT,
	  confirmed unmoved in the golden diff). The old notional implies AERO
	  priced at $2.5563; the new one implies $0.4814. AERO did not trade at
	  $2.56 on 2026-08-12 -- the old figure was the dead-pool trap from
	  bestEffortNotional's docstring, caught here on a real receipt.
	*/
	it('reprices KEYCAT->AERO off the deepest pool instead of the first match', async () => {
		const r = await analyzeTransaction(
			'0x39a026fba042a6a937e7837cc3f6f132929fdc9bf7a30cce661a91d67c1cd2b6', CHAIN, { rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();

		// Wide bounds on purpose: this is a live-chain float, and the point is to
		// fail loudly on a regression back toward the old $37,984 first-match
		// figure, not to pin the exact cent.
		expect(r!.notionalUsd).not.toBeNull();
		expect(r!.notionalUsd!).toBeGreaterThan(5000);
		expect(r!.notionalUsd!).toBeLessThan(10000);

		// The ruler this change must not touch.
		expect(r!.marketMid).toBeCloseTo(0.00082548, 6);
	}, 120000);
});
