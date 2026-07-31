/**
 * legFees.ts — Per-leg notional valuation (USDC) and LP fee roll-up.
 *
 * Pure module: no viem / RPC / DB imports. On-chain fee tiers are passed in
 * by the caller (decomposeRoute.ts).
 */

import type { Leg } from './routeGraph.js';

// ── Constants ─────────────────────────────────────────────────────────────

import { USDC, WETH } from './receiptPure.js';

// ── Interfaces ────────────────────────────────────────────────────────────

export interface LegFeeInput {
  leg: Leg;
  feeTierBps: number;       // resolved per leg (rfq=0)
  notionalUsdc: number;     // leg notional in USDC
  notionalApprox: boolean;
  /**
   * Did the fee reader actually READ this pool's tier, or fall back to 0?
   *
   * Optional with "absent = resolved" semantics so wrap/unwrap synth legs and
   * pre-existing fixtures need no change. Only an explicit `false` means the
   * tier is unknown — without it a 0 bps fee is indistinguishable from a pool
   * that is genuinely free, and the receipt renders a confident "0.00bps".
   */
  feeResolved?: boolean;
}

export interface LpRollup {
  lpFeeBps: number;
  legs: LegFeeInput[];
}

// ── Leg notional valuation ────────────────────────────────────────────────

/**
 * Value a single leg's notional in USDC.
 *
 * Priority: USDC endpoint (direct) > WETH endpoint (via usdcPerWeth) > fallback
 * to the trade-level notional (approximate).
 *
 * @param leg            The swap leg to value.
 * @param usdcPerWeth    USDC/WETH mid price at block N-1.
 * @param tradeNotionalUsdc  The overall trade notional (fallback for intermediate legs).
 * @param decimalsOf     Returns token decimals (reserved for future use; USDC=6, WETH=18
 *                       are known constants here).
 */
export function valueLegNotionalUsdc(
  leg: Leg,
  usdcPerWeth: number,
  tradeNotionalUsdc: number,
  // Retained for call-site compatibility; every branch below values a leg from its
  // USDC/WETH endpoint, so no decimals lookup is needed.
  _decimalsOf: (token: string) => number,
): { notionalUsdc: number; approx: boolean } {
  // USDC endpoints — direct conversion (6 decimals)
  if (leg.tokenIn === USDC) {
    return { notionalUsdc: Number(leg.amountInRaw) / 1e6, approx: false };
  }
  if (leg.tokenOut === USDC) {
    return { notionalUsdc: Number(leg.amountOutRaw) / 1e6, approx: false };
  }

  // WETH endpoints — convert via usdcPerWeth (18 decimals)
  if (leg.tokenIn === WETH) {
    return { notionalUsdc: (Number(leg.amountInRaw) / 1e18) * usdcPerWeth, approx: false };
  }
  if (leg.tokenOut === WETH) {
    return { notionalUsdc: (Number(leg.amountOutRaw) / 1e18) * usdcPerWeth, approx: false };
  }

  // Neither USDC nor WETH on either side — approximate with trade notional
  return { notionalUsdc: tradeNotionalUsdc, approx: true };
}

// ── LP fee roll-up ────────────────────────────────────────────────────────

/**
 * Roll up per-leg LP fees into a single trade-level LP fee in bps.
 *
 * Formula: `lpFeeBps = Σ(feeTierBps × notionalUsdc) / tradeNotionalUsdc`
 *
 * Guards against division by zero when tradeNotionalUsdc <= 0.
 */
export function rollupLpFee(
  legFees: LegFeeInput[],
  tradeNotionalUsdc: number,
): LpRollup {
  if (tradeNotionalUsdc <= 0 || legFees.length === 0) {
    return { lpFeeBps: 0, legs: legFees };
  }

  let weightedSum = 0;
  for (const lf of legFees) {
    weightedSum += lf.feeTierBps * lf.notionalUsdc;
  }

  return {
    lpFeeBps: weightedSum / tradeNotionalUsdc,
    legs: legFees,
  };
}
