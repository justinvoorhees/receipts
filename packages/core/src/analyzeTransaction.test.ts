import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { analyzeTransaction, baseIsOutputLeg, toDisplayPrice, splitFabricFee, attachLegSymbols } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = 'native';
const DEGEN = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';

describe('baseIsOutputLeg', () => {
	it('buy-side USDC→WETH: base (WETH) is the output', () => {
		expect(baseIsOutputLeg(USDC, WETH)).toBe(true);
	});
	it('sell-side WETH→USDC: base (WETH) is the input', () => {
		expect(baseIsOutputLeg(WETH, USDC)).toBe(false);
	});
	it('ranks WETH above a plain token: WETH→DEGEN base (DEGEN) is the output', () => {
		expect(baseIsOutputLeg(WETH, DEGEN)).toBe(true);
	});
	it('ranks WETH above a plain token: DEGEN→WETH base (DEGEN) is the input', () => {
		expect(baseIsOutputLeg(DEGEN, WETH)).toBe(false);
	});
	it('is case-insensitive on addresses', () => {
		expect(baseIsOutputLeg(USDC.toLowerCase(), WETH.toUpperCase())).toBe(true);
	});
	it('defaults to no inversion when both legs anchor equally (USDC↔DAI)', () => {
		expect(baseIsOutputLeg(USDC, DAI)).toBe(false);
		expect(baseIsOutputLeg(DAI, USDC)).toBe(false);
	});
	// Native ETH ('native') must anchor exactly like WETH — otherwise an
	// ETH→memecoin trade stores the price in the opposite orientation from the
	// equivalent WETH→memecoin trade, and the dashboard mislabels it.
	it('treats native ETH like WETH — native→DEGEN base (DEGEN) is the output', () => {
		expect(baseIsOutputLeg(NATIVE, DEGEN)).toBe(true);
	});
	it('treats native ETH like WETH — DEGEN→native base (DEGEN) is the input', () => {
		expect(baseIsOutputLeg(DEGEN, NATIVE)).toBe(false);
	});
	it('native ETH ranks below stablecoins — USDC→native base (native) is the output', () => {
		expect(baseIsOutputLeg(USDC, NATIVE)).toBe(true);
	});
	it('native ETH ranks below stablecoins — native→USDC base (native) is the input', () => {
		expect(baseIsOutputLeg(NATIVE, USDC)).toBe(false);
	});
});

describe('splitFabricFee', () => {
	it('attributes a >10bps Fabric-routed fee entirely to the integrator (Fabric earned 0)', () => {
		// The WARP->ETH regression: 80.64 bps forwarded to a partner feeRecipient.
		expect(splitFabricFee('fabric', 80.64)).toEqual({ integratorFeeBps: 80.64, fabricFeeBps: 0 });
	});
	it('leaves a <=10bps Fabric fee unattributed (ambiguous: Fabric surplus vs small integrator fee)', () => {
		expect(splitFabricFee('fabric', 8)).toEqual({ integratorFeeBps: null, fabricFeeBps: null });
		expect(splitFabricFee('fabric', 10)).toEqual({ integratorFeeBps: null, fabricFeeBps: null });
	});
	it('returns nulls for a zero/null fee', () => {
		expect(splitFabricFee('fabric', 0)).toEqual({ integratorFeeBps: null, fabricFeeBps: null });
		expect(splitFabricFee('fabric', null)).toEqual({ integratorFeeBps: null, fabricFeeBps: null });
	});
	it('does not attempt a split for non-Fabric aggregators (different fee model)', () => {
		expect(splitFabricFee('odos', 80)).toEqual({ integratorFeeBps: null, fabricFeeBps: null });
	});
	it('is case-insensitive on the aggregator slug', () => {
		expect(splitFabricFee('Fabric', 50)).toEqual({ integratorFeeBps: 50, fabricFeeBps: 0 });
	});
});

describe('attachLegSymbols', () => {
	const symbolFor = (a: string): string | undefined =>
		({ '0xusdc': 'USDC', '0x4200000000000000000000000000000000000006': 'WETH', native: 'ETH' })[a.toLowerCase()];

	it('attaches resolved symbols per leg (case-insensitive on address)', () => {
		const legs = [{ venue: '0xp1', type: 'univ3', tokenIn: '0xUSDC', tokenOut: '0x4200000000000000000000000000000000000006', lpFeeBps: 5 }];
		const out = attachLegSymbols(legs, symbolFor);
		expect(out[0]).toMatchObject({ tokenInSymbol: 'USDC', tokenOutSymbol: 'WETH' });
		// original leg fields are preserved untouched
		expect(out[0]).toMatchObject({ venue: '0xp1', type: 'univ3', lpFeeBps: 5 });
	});

	it('omits the symbol field when the resolver cannot resolve a token (falls back downstream)', () => {
		const legs = [{ venue: '0xp2', type: 'univ3', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: '0xEXOTIC' }];
		const out = attachLegSymbols(legs, symbolFor);
		expect(out[0]!.tokenInSymbol).toBe('WETH');
		expect('tokenOutSymbol' in out[0]!).toBe(false);
	});

	it('resolves the native sentinel to ETH', () => {
		const legs = [{ venue: '0xp3', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native' }];
		const out = attachLegSymbols(legs, symbolFor);
		expect(out[0]!.tokenOutSymbol).toBe('ETH');
	});
});

describe('toDisplayPrice', () => {
	it('passes an output-per-input price through untouched when base is the input', () => {
		expect(toDisplayPrice(3000, false)).toBe(3000);
	});
	it('inverts an output-per-input price into USD-per-base when base is the output', () => {
		expect(toDisplayPrice(1 / 3000, true)).toBeCloseTo(3000, 6);
	});
	it('returns null for a null price', () => {
		expect(toDisplayPrice(null, true)).toBeNull();
		expect(toDisplayPrice(null, false)).toBeNull();
	});
	it('returns null for a non-positive price that cannot be inverted', () => {
		expect(toDisplayPrice(0, true)).toBeNull();
		expect(toDisplayPrice(-5, true)).toBeNull();
	});
});

describe.runIf(RPC)('analyzeTransaction (integration)', () => {
	it('produces a full receipt for a known USDC/WETH smoke hash', async () => {
		const r = await analyzeTransaction(
			'0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.pricingStatus).toBe('full');
		expect(r!.inputSymbol === 'USDC' || r!.outputSymbol === 'USDC').toBe(true);
		// LP + Agg + PriceImpact + Slippage reconcile to all-in within tolerance
		expect(Math.abs(Number(r!.allInCostBps))).toBeLessThan(200);
		// Prices are stored in the display convention (USD-per-WETH), never the
		// tiny output-per-input orientation, regardless of trade direction.
		expect(Number(r!.realizedPrice)).toBeGreaterThan(100);
		expect(Number(r!.marketMid)).toBeGreaterThan(100);
		// Oracle sub-fields flow through the USDC/WETH fast-path (regression guard
		// for the priceReceipt -> Receipt forwarding wiring).
		expect(r!.chainlinkPrice).not.toBeNull();
		expect(r!.chainlinkDevBps).not.toBeNull();
	}, 60_000);

	it('returns null for a non-swap hash', async () => {
		const r = await analyzeTransaction('0x' + '00'.repeat(32), 8453, { rpcUrl: RPC! });
		expect(r).toBeNull();
	}, 60_000);

	it('prices the WARP->ETH tx on the estimated tier (bridged mid + execution + delta)', async () => {
		const r = await analyzeTransaction(
			'0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.pricingStatus).toBe('estimated');
		expect(r!.realizedPrice).not.toBeNull(); // execution price now populated
		expect(r!.marketMid).not.toBeNull(); // bridged via WARP/WETH
		expect(r!.allInCostBps).not.toBeNull(); // price delta follows
		// The cost decomposition is surfaced whenever a market mid exists — on the
		// estimated tier too, not just the oracle-validated full tier. It reconciles
		// with allInCostBps (same mid computation) even though the oracle is absent.
		expect(r!.executionBps).not.toBeNull();
		expect(r!.slippageBps).not.toBeNull();
		expect(r!.reconResidualBps).not.toBeNull();
		// Oracle fields stay null on the estimated tier.
		expect(r!.chainlinkPrice).toBeNull();
		// Route now decomposes to a linear 3-hop (native-ETH exit modeled as WETH).
		const legs = r!.routeLegs as { venue: string; type: string; lpFeeBps: number | null; priceImpactBps: number | null; tokenInSymbol?: string; tokenOutSymbol?: string }[];
		// Per-leg token symbols are resolved and stored (incl. the WARP endpoint,
		// absent from the dashboard's static map).
		expect(legs.some((l) => l.tokenInSymbol === 'WARP' || l.tokenOutSymbol === 'WARP')).toBe(true);
		expect(legs.every((l) => l.tokenInSymbol && l.tokenOutSymbol)).toBe(true);
		const venues = legs.map((l) => l.venue.toLowerCase());
		expect(venues).toContain('0x53932cbd6cddbb907ce1bb108496c7bd8aaa5dce'); // Uni V3 WARP/WETH
		expect(venues).toContain('0x498581ff718922c3f8e6a244956af099b2652b2b'); // Uni V4 PM (USDC/native-ETH)
		expect(legs.filter((l) => typeof l.lpFeeBps === 'number').length).toBeGreaterThanOrEqual(3);
		// Per-leg price impact is surfaced on the estimated tier (previously nulled).
		expect(legs.filter((l) => typeof l.priceImpactBps === 'number').length).toBeGreaterThanOrEqual(1);
		expect(r!.routeShape).toBe('linear');
		// No wrap/unwrap in this route (V4 pays native ETH directly).
		expect(legs.some((l) => l.type === 'wrap' || l.type === 'unwrap')).toBe(false);
	}, 30_000);

	it('decomposes a native-ETH-INPUT (ETH->USDC) trade with no spurious leg from the outer EOA->router frame', async () => {
		// Odos ETH->USDC on Base, block 48452452: EOA sends native ETH directly to
		// the Odos router, which wraps to WETH and swaps WETH->USDC on a Uni V2
		// pool. `extractNativeTransfers` walks every value-moving CALL frame,
		// INCLUDING the outer EOA->router frame — the concern (per
		// native-eth-decomposition-followups) was that this could inject a
		// spurious/duplicate WETH node into the route graph. It doesn't: the
		// outer EOA->router transfer collapses into the informational wrap step
		// (native->WETH), and exactly one costed leg (the real WETH->USDC pool)
		// comes out the other side.
		const r = await analyzeTransaction(
			'0xf87c9ea6a765d1e52c96156fdefa6ac8340ec7509c81359f2e57a34220ef31bd',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.inputSymbol).toBe('ETH');
		expect(r!.outputSymbol).toBe('USDC');
		expect(r!.routeShape).toBe('single');
		expect(r!.decompConfidence).toBe('high');

		const legs = r!.routeLegs as { venue: string; type: string; tokenIn: string; tokenOut: string; lpFeeBps: number | null }[];
		// Exactly two legs total: the informational wrap + one costed pool leg.
		// If the outer EOA->router native-value frame leaked in as its own node,
		// this would be 3+.
		expect(legs).toHaveLength(2);

		const wrapLeg = legs.find((l) => l.type === 'wrap');
		expect(wrapLeg).toBeDefined();
		expect(wrapLeg!.tokenIn).toBe('native');
		expect(wrapLeg!.tokenOut.toLowerCase()).toBe(WETH);
		expect(wrapLeg!.lpFeeBps).toBeNull();

		const costedLegs = legs.filter((l) => typeof l.lpFeeBps === 'number');
		expect(costedLegs).toHaveLength(1);
		expect(costedLegs[0]!.venue.toLowerCase()).toBe('0xab067c01c7f5734da168c699ae9d23a4512c9fdb'); // Uni V2 WETH/USDC
		expect(costedLegs[0]!.tokenIn.toLowerCase()).toBe(WETH);
		expect(costedLegs[0]!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
		expect(costedLegs[0]!.lpFeeBps).toBeCloseTo(29.88, 1);
	}, 30_000);

	it('decomposes a convergent multi-hop split (LFI->GITLAWB) with per-leg impact + slippage', async () => {
		const r = await analyzeTransaction(
			'0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		// Previously ROUTE_NOT_DECOMPOSED (null slippage + all-null per-leg impact).
		expect(r!.slippageBps).not.toBeNull();
		const legs = r!.routeLegs as { priceImpactBps: number | null }[];
		expect(legs.filter((l) => typeof l.priceImpactBps === 'number').length).toBeGreaterThanOrEqual(1);
		expect((r!.normalizeFlags as string[]).some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
	}, 30_000);

	it('reconstructs the 0x Settler RFQ+AMM hybrid route (id 189 pin: round-trip maker netting)', async () => {
		// 2.8 ETH → 1.30M jesse. Pre-fix: the RFQ maker's USDC change flow broke
		// intermediate-token conservation → ROUTE_NOT_DECOMPOSED, null LP/slippage.
		const r = await analyzeTransaction(
			'0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.lpFeeBps).not.toBeNull();
		expect(r!.slippageBps).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('LEG_AMOUNTS_NETTED'))).toBe(true);
		expect(r!.normalizeFlags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
		expect(r!.decompConfidence).not.toBe('high');
	}, 60_000);

	it('types the 0x Settler maker leg rfq and prices around it (id 189 follow-on)', async () => {
		const r = await analyzeTransaction(
			'0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const legs = r!.routeLegs as { venue: string; type: string; priceImpactBps: number | null }[];
		const maker = legs.find((l) => l.venue === '0x69a9f156d5902191dce331ab348f3e9e96e48b22');
		expect(maker).toBeDefined();
		expect(maker!.type).toBe('rfq');
		expect(maker!.priceImpactBps).toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(true);
		// The maker leg must not carry a garbage AMM benchmark anymore…
		expect(r!.normalizeFlags.some((f) => f.startsWith('PI_IMPLAUSIBLE') && f.includes('0x69a9f156'))).toBe(false);
		// …and the netting-era reconstruction must still hold.
		expect(r!.lpFeeBps).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
	}, 60_000);

	it('types an EOA limit-order maker leg rfq (row 118 pin)', async () => {
		const r = await analyzeTransaction(
			'0x1bc9fb0965659a9768c3f71f7ea57bbe41a25682416dcfc3652baf5b10364e69',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const legs = r!.routeLegs as { venue: string; type: string; priceImpactBps: number | null }[];
		const maker = legs.find((l) => l.venue === '0x7d94baf661d5ed8ad30d7241d1a50f3883083ef7');
		expect(maker).toBeDefined();
		expect(maker!.type).toBe('rfq'); // bare EOA → tier 2
		expect(maker!.priceImpactBps).toBeNull();
	}, 60_000);
});

describe('analyzeTransaction — 0x Settler identity (e2e)', () => {
	// The tx that motivated this work. `to` = 0x7747f8d2… = 0x Settler feature 2.
	const ZEROX_TX = '0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26';

	it.skipIf(!RPC)('labels the 0x Settler trade as 0x, via the resolver', async () => {
		const r = await analyzeTransaction(ZEROX_TX, 8453, { rpcUrl: RPC! });
		expect(r).toBeTruthy();
		expect(r!.aggregator).toBe('0x');
		expect(r!.normalizeFlags).toContain('AGGREGATOR_DETECTED_VIA: resolver');
	}, 60_000);

	it.skipIf(!RPC)('does not emit a spurious SETTLEMENT_EVENT_MISSING for 0x', async () => {
		// 0x's log is anonymous, so a missing topic is expected, not a defect.
		const r = await analyzeTransaction(ZEROX_TX, 8453, { rpcUrl: RPC! });
		const flags = (r!.normalizeFlags ?? []) as string[];
		expect(flags.some((f) => f.startsWith('SETTLEMENT_EVENT_MISSING'))).toBe(false);
		expect(flags.some((f) => f.startsWith('NO_SIGNATURE'))).toBe(false);
		expect(r!.settlementEventSeen).toBe(false);
		expect(r!.settlementEventTopic0).toBeNull();
	}, 60_000);
});
