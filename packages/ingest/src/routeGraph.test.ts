import { describe, expect, it } from 'vitest';
import { buildRouteGraph } from './routeGraph.js';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const trader = '0x00000000000000000000000000000000000000d0';
const pcs = '0x7cb770d0513c30e0cb45e4899e4a2cbeed6f9830';
const v4 = '0x498581ff718922c3f8e6a244956af099b2652b2b';
// USDC→VIRTUAL (pcs) → VIRTUAL→WETH (v4)
const transfers = [
  { token: USDC, from: trader, to: pcs, value: 2_000000n },
  { token: VIRTUAL, from: pcs, to: v4, value: 3_000000000000000000n },
  { token: WETH, from: v4, to: trader, value: 1_000000000000000n },
];
const venues = new Map([[pcs, { type: 'pancakev3' as const }], [v4, { type: 'univ4' as const }]]);
describe('buildRouteGraph', () => {
  it('orders a linear USDC→VIRTUAL→WETH route', () => {
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.shape).toBe('linear');
    expect(g.reconstructed).toBe(true);
    expect(g.inputToken).toBe(USDC);
    expect(g.outputToken).toBe(WETH);
    expect(g.legs.map(l => `${l.type}:${l.tokenIn.slice(0,6)}>${l.tokenOut.slice(0,6)}`))
      .toEqual([`pancakev3:${USDC.slice(0,6)}>${VIRTUAL.slice(0,6)}`, `univ4:${VIRTUAL.slice(0,6)}>${WETH.slice(0,6)}`]);
    expect(g.legs[0]!.amountInRaw).toBe(2_000000n);
    expect(g.legs[1]!.amountOutRaw).toBe(1_000000000000000n);
  });
  it('flags an RFQ filler (no Swap event) as an rfq leg', () => {
    const rfq = '0xbee3211ab312a8d065c4fef0247448e17a8da000';
    const t2 = [
      { token: USDC, from: trader, to: rfq, value: 2_000000n },
      { token: VIRTUAL, from: rfq, to: v4, value: 3_000000000000000000n },
      { token: WETH, from: v4, to: trader, value: 1_000000000000000n },
    ];
    const g = buildRouteGraph({ transfers: t2, trader, venues: new Map([[v4, { type: 'univ4' as const }]]), denylist: new Set() });
    expect(g.legs[0]!.type).toBe('rfq');
    expect(g.shape).toBe('linear');
  });

  it('single-leg: direct USDC→WETH swap through one venue', () => {
    const pool = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const t = [
      { token: USDC, from: trader, to: pool, value: 500_000000n },
      { token: WETH, from: pool, to: trader, value: 250_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([[pool, { type: 'univ3' as const }]]),
      denylist: new Set(),
    });
    expect(g.shape).toBe('single');
    expect(g.reconstructed).toBe(true);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0]!.tokenIn).toBe(USDC);
    expect(g.legs[0]!.tokenOut).toBe(WETH);
    expect(g.legs[0]!.type).toBe('univ3');
  });

  it('complex (stalled chain): orphan leg that does not chain', () => {
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const AERO = '0xcccccccccccccccccccccccccccccccccccccccc';
    // poolA: USDC→VIRTUAL (connects from input)
    // poolB: AERO→WETH (orphan — AERO isn't produced by any leg or the input)
    const t = [
      { token: USDC, from: trader, to: poolA, value: 1_000000n },
      { token: VIRTUAL, from: poolA, to: trader, value: 2_000000000000000000n },
      { token: AERO, from: trader, to: poolB, value: 500_000000000000000n },
      { token: WETH, from: poolB, to: trader, value: 100_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([
        [poolA, { type: 'univ3' as const }],
        [poolB, { type: 'aerodrome' as const }],
      ]),
      denylist: new Set(),
    });
    // Trader's largest negative delta is VIRTUAL (2e18 sent effectively — but
    // actually USDC is 1e6 and AERO is 5e17; VIRTUAL has +2e18 positive).
    // The trader sends USDC(1e6) and AERO(5e17) — both negative.
    // Trader receives VIRTUAL(2e18) and WETH(1e17) — both positive.
    // Largest negative = AERO (5e17 > 1e6), largest positive = VIRTUAL (2e18 > 1e17).
    // So inputToken=AERO, outputToken=VIRTUAL.
    // poolA leg: USDC→VIRTUAL — tokenIn(USDC)!=inputToken(AERO) so chain stalls.
    expect(g.shape).toBe('complex');
    expect(g.reconstructed).toBe(false);
  });

  it('split: trader fans out to two venues producing output token', () => {
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // Both venues receive USDC from trader and return WETH to trader
    const t = [
      { token: USDC, from: trader, to: poolA, value: 1_000000n },
      { token: WETH, from: poolA, to: trader, value: 500_000000000000000n },
      { token: USDC, from: trader, to: poolB, value: 1_000000n },
      { token: WETH, from: poolB, to: trader, value: 500_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([
        [poolA, { type: 'univ3' as const }],
        [poolB, { type: 'univ2' as const }],
      ]),
      denylist: new Set(),
    });
    expect(g.shape).toBe('split');
    expect(g.reconstructed).toBe(false);
    expect(g.legs).toHaveLength(2);
    expect(g.inputToken).toBe(USDC);
    expect(g.outputToken).toBe(WETH);
  });

  it('C1 regression: multi-token venue yields complex, not guessed leg', () => {
    const multiVenue = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const TOKB = '0xdddddddddddddddddddddddddddddddddddddd';
    // multiVenue receives USDC and TOKB, sends WETH and VIRTUAL
    // → 2 net-received, 2 net-sent: must NOT guess a single leg
    const t = [
      { token: USDC, from: trader, to: multiVenue, value: 1_000000n },
      { token: TOKB, from: trader, to: multiVenue, value: 2_000000n },
      { token: WETH, from: multiVenue, to: trader, value: 500_000000000000000n },
      { token: VIRTUAL, from: multiVenue, to: trader, value: 1_000000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([[multiVenue, { type: 'univ3' as const }]]),
      denylist: new Set(),
    });
    // No legs should be emitted for this multi-token venue
    expect(g.legs).toHaveLength(0);
    expect(g.shape).toBe('complex');
    expect(g.reconstructed).toBe(false);
  });
});
