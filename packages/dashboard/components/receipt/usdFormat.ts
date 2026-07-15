// USD magnitude formatting, in a leaf module that imports nothing.
//
// A pure function with no React/client dependency. It lives here rather than in
// TradesTable so the quarantined receipt/qualityNotionals (and any future
// server-side consumer) can import it without dragging in TradesTable's
// 'use client' → ReceiptView chain.

// USD magnitude without the leading '$'. Sub-cent values (0 < |v| < 0.01) get
// 6 significant figures so memecoin unit prices and dust notionals don't round
// to $0.00; everything else keeps the 2-decimal grouped form. Returns null for
// zero / non-finite so callers choose their own placeholder.
export function formatUsdMagnitude(value: number): string | null {
	if (!Number.isFinite(value) || value === 0) return null;
	const abs = Math.abs(value);
	if (abs < 0.01) {
		return abs.toLocaleString('en-US', { maximumSignificantDigits: 6 });
	}
	return abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
