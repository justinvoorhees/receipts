export function formatBps(value: number | null): string {
	if (value === null) return '–';
	return `${value.toFixed(1)}bps`;
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

// Per-provider accent colors used in the cross-experiment scatter chart.
// Values map to the existing --color-fabric-* CSS variables in theme.css so
// they participate in theme switching cleanly.
const PROVIDER_COLOR_VARS: Record<string, string> = {
	fabric: 'var(--color-fabric-purple)',
	nordstern: 'var(--color-fabric-blue)',
	kyberswap: 'var(--color-fabric-green)',
	odos: 'var(--color-fabric-pink)',
	relay: 'var(--color-fabric-yellow)',
	'0x': 'var(--color-fabric-red)',
	velora: 'var(--color-fabric-light-blue)',
};

export function providerColor(slug: string): string {
	return PROVIDER_COLOR_VARS[slug] ?? 'var(--color-primary)';
}
