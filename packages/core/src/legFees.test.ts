import { describe, expect, it } from 'vitest';
import { valueLegNotionalUsdc, rollupLpFee } from './legFees.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const V = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';

const dec = (t: string) => (t === USDC ? 6 : 18);
const baseLeg = { venue: '0x', type: 'univ3' as const, amountInRaw: 0n, amountOutRaw: 0n };

describe('valueLegNotionalUsdc', () => {
  it('values a USDC-input leg directly', () => {
    const r = valueLegNotionalUsdc(
      { ...baseLeg, tokenIn: USDC, tokenOut: V, amountInRaw: 2_000000n, amountOutRaw: 3n },
      2000,
      2.0,
      dec,
    );
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6);
    expect(r.approx).toBe(false);
  });

  it('values a USDC-output leg directly', () => {
    const r = valueLegNotionalUsdc(
      { ...baseLeg, tokenIn: V, tokenOut: USDC, amountInRaw: 3n, amountOutRaw: 2_000000n },
      2000,
      2.0,
      dec,
    );
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6);
    expect(r.approx).toBe(false);
  });

  it('values a WETH-input leg via usdcPerWeth', () => {
    const r = valueLegNotionalUsdc(
      { ...baseLeg, tokenIn: WETH, tokenOut: V, amountInRaw: 1_000000000000000n, amountOutRaw: 3n },
      2000,
      2.0,
      dec,
    );
    // 0.001 WETH * 2000 = 2.0
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6);
    expect(r.approx).toBe(false);
  });

  it('values a WETH-output leg via usdcPerWeth', () => {
    const r = valueLegNotionalUsdc(
      { ...baseLeg, tokenIn: V, tokenOut: WETH, amountInRaw: 3n, amountOutRaw: 1_000000000000000n },
      2000,
      2.0,
      dec,
    );
    // 0.001 WETH * 2000 = 2.0
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6);
    expect(r.approx).toBe(false);
  });

  it('approximates a pure-intermediate leg with the trade notional', () => {
    const r = valueLegNotionalUsdc(
      { ...baseLeg, tokenIn: V, tokenOut: '0xother', amountInRaw: 3n, amountOutRaw: 4n },
      2000,
      1.8027,
      dec,
    );
    expect(r.notionalUsdc).toBeCloseTo(1.8027, 6);
    expect(r.approx).toBe(true);
  });
});

describe('rollupLpFee', () => {
  it('sums fee tiers weighted by leg notional over trade notional', () => {
    const r = rollupLpFee(
      [
        { leg: { ...baseLeg, tokenIn: USDC, tokenOut: V }, feeTierBps: 5, notionalUsdc: 2, notionalApprox: false },
        { leg: { ...baseLeg, tokenIn: V, tokenOut: WETH }, feeTierBps: 100, notionalUsdc: 2, notionalApprox: false },
      ],
      2,
    );
    // (5*2 + 100*2) / 2 = 210/2 = 105
    expect(r.lpFeeBps).toBeCloseTo(105, 6);
    expect(r.legs).toHaveLength(2);
  });

  it('returns lpFeeBps 0 when tradeNotionalUsdc <= 0', () => {
    const r = rollupLpFee(
      [{ leg: { ...baseLeg, tokenIn: USDC, tokenOut: V }, feeTierBps: 5, notionalUsdc: 2, notionalApprox: false }],
      0,
    );
    expect(r.lpFeeBps).toBe(0);
  });

  it('returns lpFeeBps 0 for empty leg array', () => {
    const r = rollupLpFee([], 100);
    expect(r.lpFeeBps).toBe(0);
    expect(r.legs).toHaveLength(0);
  });
});
