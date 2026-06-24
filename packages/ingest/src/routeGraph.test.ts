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
});
