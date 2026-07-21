/**
 * Sign-flipped component contribution — displays a cost-model component
 * (lp_fee_bps, agg_fee_bps, slippage_bps) as a signed contribution to
 * Accuracy. Since `Accuracy = -all_in_cost` and `all_in = lp + agg + slippage`,
 * each contribution is displayed as `-component` so they SUM to Accuracy.
 *
 * Returns { text, color } so the caller can apply green (positive = surplus)
 * or red (negative = cost to user).
 */
export function formatContribution(
	rawBps: number | null,
): { text: string; color: string | undefined } {
	if (rawBps === null) return { text: '–', color: undefined };
	const flipped = -rawBps; // sign-flip: positive = good for user
	// Show a leading '+' only for strictly-positive values; an exact 0.0 (and
	// any value that rounds to it, incl. -0.0) renders as a bare "0.0bps".
	const rounded = Number(flipped.toFixed(1));
	const text = rounded === 0 ? '0.0bps' : `${rounded.toFixed(1)}bps`;
	const color = flipped > 0.05 ? '#117d45' : undefined;
	return { text, color };
}

/**
 * Larger USD amounts — notionals, fee totals. Uses Intl with no fractional
 * digits since trades are $500k+ and cents aren't meaningful at that scale.
 */
const NOTIONAL_FMT = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	maximumFractionDigits: 0,
});
export function formatNotional(value: number | null): string {
	if (value === null) return '–';
	return NOTIONAL_FMT.format(value);
}

/**
 * USD formatter with 4 decimals — used for gas costs, which on Base typically
 * land in the fractional-cent range ($0.0001 - $0.005). Two-decimal $0.00
 * rounding would be useless for that range.
 */
export function formatGasUsd(value: number | null): string {
	if (value === null) return '–';
	return `$${value.toFixed(4)}`;
}

export function shortTxHash(txHash: string): string {
	return `${txHash.slice(0, 6)}…${txHash.slice(-4)}`;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	fabric: 'Fabric',
	kyberswap: 'KyberSwap',
	'0x': '0x',
	'1inch': '1inch',
	nordstern: 'Nordstern',
	odos: 'Odos',
	okx: 'OKX',
	openocean: 'OpenOcean',
	relay: 'Relay',
	velora: 'Velora',
};

// Unidentified aggregators fall back to their raw router address as the
// slug — by default truncate it the same way as a tx hash so it can't blow
// out the History table's column width (purely a layout guard). The receipt
// has room, so it passes `full: true` to show the whole address. Identifying
// these is separate work.
export function formatProvider(slug: string, opts?: { full?: boolean }): string {
	const known = PROVIDER_DISPLAY_NAMES[slug];
	if (known) return known;
	if (slug.startsWith('0x') && slug.length > 10) {
		return opts?.full ? slug : shortTxHash(slug);
	}
	return slug;
}

// Per-provider accent hexes. Values from the Figma trust-matrix spec — kept
// as raw hex (not theme vars) because the dots are part of the data viz and
// should stay visually anchored across theme switches.
const PROVIDER_COLOR_HEX: Record<string, string> = {
	fabric: '#8800ff',
	nordstern: '#332bfd',
	kyberswap: '#117d45',
	odos: '#fb42df',
	relay: '#fba808',
	'0x': '#fa0b54',
	'1inch': '#d82122',
	velora: '#0bc1fa',
	// No okx/openocean entries: the Figma spec predates both and carries no value
	// for either, so they intentionally fall back to var(--color-primary) via
	// providerColor() rather than ship invented hexes under a spec-sourced comment.
};

export function providerColor(slug: string): string {
	return PROVIDER_COLOR_HEX[slug] ?? 'var(--color-primary)';
}
