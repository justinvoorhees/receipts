export function formatBps(value: number | null): string {
	if (value === null) return '–';
	return `${value.toFixed(1)}bps`;
}

/**
 * Sign-flipped framing of cost-bps. Our schema stores `positive = cost paid
 * by user`, but the dashboard prefers "accuracy" framing where positive =
 * surplus over reference. So `mean(total_cost_bps) = +12.3` (user paid)
 * renders as accuracy `-12.3bps` (user is down).
 */
export function formatAccuracy(costBps: number | null): string {
	if (costBps === null) return '–';
	return formatBps(-costBps);
}

/**
 * Variability (stddev) is always presented prefixed with ± to signal it's a
 * spread, not a magnitude. Pairs naturally with a mean rendered via formatBps:
 * `29.8bps  ± 9.0bps`.
 */
export function formatVariability(value: number | null): string {
	if (value === null) return '–';
	return `±${value.toFixed(1)}bps`;
}

export function formatUsd(value: number | null): string {
	if (value === null) return '–';
	return `$${value.toFixed(2)}`;
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

export function formatTime(date: Date): string {
	return date.toISOString().slice(11, 19);
}

/**
 * "Jun 16, 14:32" — compact UTC stamp for trade rows. Same day's trades
 * cluster visually; the month/day disambiguates older rows once you scroll.
 */
export function formatTradeTimestamp(epochSeconds: number): string {
	const d = new Date(epochSeconds * 1000);
	const monthDay = d.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	});
	const hhmm = d.toISOString().slice(11, 16);
	return `${monthDay}, ${hhmm}`;
}

export function shortTxHash(txHash: string): string {
	return `${txHash.slice(0, 6)}…${txHash.slice(-4)}`;
}

export function formatDirection(direction: string | null): string {
	if (direction === 'buy_weth') return 'Buy WETH';
	if (direction === 'sell_weth') return 'Sell WETH';
	return direction ?? '–';
}

const CHAIN_DISPLAY_NAMES: Record<string, string> = {
	base: 'Base',
};

export function formatChain(slug: string): string {
	return CHAIN_DISPLAY_NAMES[slug] ?? slug;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	fabric: 'Fabric',
	kyberswap: 'KyberSwap',
	'0x': '0x',
	nordstern: 'Nordstern',
	odos: 'Odos',
	relay: 'Relay',
	velora: 'Velora',
};

export function formatProvider(slug: string): string {
	return PROVIDER_DISPLAY_NAMES[slug] ?? slug;
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
	velora: '#0bc1fa',
};

export function providerColor(slug: string): string {
	return PROVIDER_COLOR_HEX[slug] ?? 'var(--color-primary)';
}
