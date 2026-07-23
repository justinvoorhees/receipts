/**
 * receiptPure.ts — the pure, dependency-free receipt helpers the dashboard needs.
 *
 * These functions (anchor detection, base/quote orientation, and the single-ruler
 * reconciliation) are pure arithmetic/string logic with NO I/O, NO viem, NO fs. They
 * live in this leaf — and are exposed via the `@fabric-tca/core/pure` subpath — so a
 * `'use client'` component can import them WITHOUT dragging the barrel (which re-exports
 * `analyzeTransaction` → `tagging` → `node:fs`) into the browser bundle.
 *
 * The definitions here are the single source of truth used by both server code (via the
 * barrel) and the dashboard. `receiptPure.test.ts` cross-checks them against the barrel's
 * exports so the two can never silently diverge.
 */

// ── Anchor token addresses (Base) ────────────────────────────────────────────
// Exported so the server-side modules (pricing/analyzeTransaction) share the ONE
// definition rather than re-declaring their own copies.
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca';
export const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
export const WETH = '0x4200000000000000000000000000000000000006';
/** Synthetic endpoint for native ETH. */
export const NATIVE = 'native';

export const STABLECOINS: ReadonlySet<string> = new Set([USDC, USDBC, DAI]);

export const isStable = (t: string): boolean => STABLECOINS.has(t.toLowerCase());
export const isWeth = (t: string): boolean => t.toLowerCase() === WETH;
export const isNative = (t: string): boolean => t.toLowerCase() === NATIVE;

/**
 * A token anchors to USD if it's a stablecoin, WETH, or native ETH — it has a
 * reliable, liquid USD reference (stable ≈ $1; WETH/ETH via WETH/USDC).
 */
export const anchorsToUsd = (t: string): boolean => isStable(t) || isWeth(t) || isNative(t);

/**
 * Anchor rank: stablecoins (2) outrank ETH/WETH (1), which outrank everything (0).
 * The stronger anchor is the quote; the weaker leg is the volatile "base".
 */
export function anchorRank(token: string): number {
  const t = token.toLowerCase();
  if (STABLECOINS.has(t)) return 2;
  // Native ETH is the same reference asset as WETH — anchor it identically.
  if (t === WETH || t === NATIVE) return 1;
  return 0;
}

/**
 * True when the price's base (volatile) leg is the OUTPUT token (a buy like
 * USDC→WETH). Stored realized/mid prices are output-per-input; when the base is the
 * output they are inverted to reach the display convention. Ties → false.
 */
export function baseIsOutputLeg(inputToken: string, outputToken: string): boolean {
  return anchorRank(outputToken) < anchorRank(inputToken);
}

/**
 * The single-ruler identity: from ONE market mid, the dollar execution result and the
 * bps execution quality are two views of the same number. All prices output-per-input;
 * `notionalUsd` must be the INPUT (paid) side's notional for `execResultUsd` to equal
 * `notionalOut − notionalIn` exactly.
 */
export function reconciledResult(args: {
  marketMid: number;
  realizedPrice: number;
  notionalUsd: number;
}): { execResultUsd: number; qualityBps: number } {
  const ratio = args.realizedPrice / args.marketMid - 1;
  return { execResultUsd: args.notionalUsd * ratio, qualityBps: ratio * 10_000 };
}
