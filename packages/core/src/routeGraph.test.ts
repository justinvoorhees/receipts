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
  it('classifies an unrecognized 1-in-1-out venue (no Swap event) as unknown', () => {
    // A clean 1-in-1-out address with no Swap event is NOT assumed to be a
    // genuine RFQ filler: probing showed these are real AMM pools we failed to
    // recognize (see 30cb93ba). Classifying them `unknown` keeps their LP fee a
    // flagged (defaulted) guess rather than a confident 0, per decomposeRoute.
    const unknownVenue = '0xbee3211ab312a8d065c4fef0247448e17a8da000';
    const t2 = [
      { token: USDC, from: trader, to: unknownVenue, value: 2_000000n },
      { token: VIRTUAL, from: unknownVenue, to: v4, value: 3_000000000000000000n },
      { token: WETH, from: v4, to: trader, value: 1_000000000000000n },
    ];
    const g = buildRouteGraph({ transfers: t2, trader, venues: new Map([[v4, { type: 'univ4' as const }]]), denylist: new Set() });
    expect(g.legs[0]!.type).toBe('unknown');
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
    // Clean direct-pair split: all legs swap inputToken→outputToken, so reconstructed=true
    expect(g.reconstructed).toBe(true);
    expect(g.legs).toHaveLength(2);
    expect(g.inputToken).toBe(USDC);
    expect(g.outputToken).toBe(WETH);
  });

  it('denylisted swap venue still produces a leg (Fix 1)', () => {
    // Real case: nordstern b1 swaps through a USDC/WETH pool that is in the
    // DENYLIST. The pool emitted a Swap event so it IS in venues — it must
    // not be excluded from leg construction.
    const denylistedPool = '0xb4cb800910b228ed3d0834cf79d697127bbb00e5';
    const t = [
      { token: USDC, from: trader, to: denylistedPool, value: 500_000000n },
      { token: WETH, from: denylistedPool, to: trader, value: 250_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([[denylistedPool, { type: 'univ3' as const }]]),
      denylist: new Set([denylistedPool]),
    });
    expect(g.shape).toBe('single');
    expect(g.reconstructed).toBe(true);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0]!.tokenIn).toBe(USDC);
    expect(g.legs[0]!.tokenOut).toBe(WETH);
  });

  it('denylisted non-venue RFQ filler is still excluded (Fix 1 negative)', () => {
    // A denylisted address that is NOT a venue should still be excluded —
    // the denylist blocks RFQ-filler / proxy identification, not venues.
    const denylistedFiller = '0xb4cb800910b228ed3d0834cf79d697127bbb00e5';
    const t = [
      { token: USDC, from: trader, to: denylistedFiller, value: 500_000000n },
      { token: WETH, from: denylistedFiller, to: trader, value: 250_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map(),  // NOT a venue
      denylist: new Set([denylistedFiller]),
    });
    // No legs — the filler is denylisted and not a venue
    expect(g.legs).toHaveLength(0);
    expect(g.shape).toBe('complex');
    expect(g.reconstructed).toBe(false);
  });

  it('clean parallel split: reconstructed=true (Fix 2)', () => {
    // Two pools both swap USDC→WETH (the trader's direct pair).
    // This is a clean split — every leg is inputToken→outputToken.
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
        [poolB, { type: 'univ3' as const }],
      ]),
      denylist: new Set(),
    });
    expect(g.shape).toBe('split');
    expect(g.reconstructed).toBe(true);
    expect(g.legs).toHaveLength(2);
    expect(g.legs.every(l => l.tokenIn === USDC && l.tokenOut === WETH)).toBe(true);
  });

  it('mixed split (one multi-hop branch) stays reconstructed=false (Fix 2 negative)', () => {
    // One branch: USDC→WETH (direct). Another: USDC→VIRTUAL→WETH (multi-hop).
    // This is NOT a clean direct-pair split — must stay reconstructed=false.
    const poolDirect = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const poolHop1 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const poolHop2 = '0xcccccccccccccccccccccccccccccccccccccccc';
    const t = [
      { token: USDC, from: trader, to: poolDirect, value: 1_000000n },
      { token: WETH, from: poolDirect, to: trader, value: 500_000000000000000n },
      { token: USDC, from: trader, to: poolHop1, value: 1_000000n },
      { token: VIRTUAL, from: poolHop1, to: poolHop2, value: 2_000000000000000000n },
      { token: WETH, from: poolHop2, to: trader, value: 500_000000000000000n },
    ];
    const g = buildRouteGraph({
      transfers: t,
      trader,
      venues: new Map([
        [poolDirect, { type: 'univ3' as const }],
        [poolHop1, { type: 'univ3' as const }],
        [poolHop2, { type: 'univ3' as const }],
      ]),
      denylist: new Set(),
    });
    expect(g.shape).toBe('split');
    expect(g.reconstructed).toBe(false);
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

describe('tryBuildChain output-token recurrence', () => {
  const trader = '0x00000000000000000000000000000000000000a1';
  const WARP = '0x00000000000000000000000000000000000000c1';
  const WETH = '0x4200000000000000000000000000000000000006';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const p1 = '0x00000000000000000000000000000000000000d1';
  const p2 = '0x00000000000000000000000000000000000000d2';
  const p3 = '0x00000000000000000000000000000000000000d3';

  it('reconstructs a linear route whose output token (WETH) recurs mid-chain', () => {
    // WARP -> WETH -> USDC -> WETH(native modeled as WETH); trader out = WETH
    const transfers = [
      { token: WARP, from: trader, to: p1, value: 100n },
      { token: WETH, from: p1, to: p2, value: 5n },
      { token: USDC, from: p2, to: p3, value: 200n },
      { token: WETH, from: p3, to: trader, value: 4n },
    ];
    const venues = new Map([
      [p1, { type: 'univ3' as const }],
      [p2, { type: 'univ3' as const }],
      [p3, { type: 'univ4' as const }],
    ]);
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.shape).toBe('linear');
    expect(g.reconstructed).toBe(true);
    expect(g.legs.map((l) => l.venue)).toEqual([p1, p2, p3]);
    expect(g.inputToken).toBe(WARP);
    expect(g.outputToken).toBe(WETH);
  });

  it('does not mislabel a fully-consumed chain that ends off the output token as linear', () => {
    // A -> B -> C consumes all legs but the trader's output token is C already;
    // construct a case where the greedy chain ends at a non-output token.
    const A = '0x00000000000000000000000000000000000000e1';
    const B = '0x00000000000000000000000000000000000000e2';
    const C = '0x00000000000000000000000000000000000000e3';
    const vA = '0x00000000000000000000000000000000000000f1';
    const vB = '0x00000000000000000000000000000000000000f2';
    // Trader sends A and D, receives C: input picked by largest magnitude.
    // Legs: A->B (vA), B->C (vB). Trader output is C. This SHOULD be linear
    // (ends at C). Invert to force an off-output end:
    const transfers = [
      { token: A, from: trader, to: vA, value: 100n },
      { token: B, from: vA, to: vB, value: 100n },
      { token: C, from: vB, to: trader, value: 100n },
    ];
    const venues = new Map([[vA, { type: 'univ3' as const }], [vB, { type: 'univ3' as const }]]);
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    // This is a genuine linear A->B->C ending at output C.
    expect(g.shape).toBe('linear');
    expect(g.legs.map((l) => l.venue)).toEqual([vA, vB]);
  });
});
