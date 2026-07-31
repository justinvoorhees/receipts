'use client';
/**
 * receiptDisplay — pure formatting + route/venue/fee display helpers shared by the
 * History table (TradesTable) and the Receipt (ReceiptView).
 *
 * These lived in TradesTable, which forced ReceiptView to import from it while
 * TradesTable imported <Receipt> back — a circular dependency that made `.next`
 * builds cascade (see the single-ruler memory). Extracting the shared surface into
 * this leaf breaks the cycle: both components now depend on this module, and it
 * depends on neither. ShareButton (a small client component) rides along, so the
 * module is marked 'use client'.
 */
import { useState } from 'react';
import { costedLegs, isFullyPriced, priceImpactCoverage } from '@fabric-tca/core/pure';
import { formatProvider, shortTxHash } from '../../lib/formatters';
import type { ReceiptRow, RouteLeg } from '../../lib/queries';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './symbols';
import { formatUsdMagnitude } from './usdFormat';

export function formatSubvalueUsd(value: number): string {
	const mag = formatUsdMagnitude(value);
	return mag == null ? '–' : `$${mag}`;
}

// Re-exported from receipt/usdFormat.ts (a leaf module) so existing external
// consumers of TradesTable's formatUsdMagnitude keep working unchanged.
export { formatUsdMagnitude };

export function ShareButton({ path, large = false }: { path?: string; large?: boolean } = {}) {
	const [copied, setCopied] = useState(false);

	const handleClick = async () => {
		const url = path != null ? new URL(path, window.location.origin).toString() : window.location.href;
		await navigator.clipboard.writeText(url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	// `large` is the standalone receipt page's 69px bar (Figma 547-1011). The
	// History dialog keeps the original 40px button — it is deliberately out of
	// scope for the v3 pass.
	const sizing = large
		? 'h-[69px] text-[40px] leading-[40px] px-[20px]'
		: 'h-[40px] text-[20px] leading-[20px] px-[8px]';

	// Hover dims the LABEL to quaternary and leaves the fill alone (Mochromat
	// 1564-977, `type=primary, state=hover`). The design-system node binds its
	// fill to `focus` where this button uses `primary` — a pre-existing token
	// difference, and not one to "fix" here: they are near-identical in the
	// light theme but diverge hard in others (terminal: #00fa9a vs #0afa4a), so
	// swapping the resting fill would be a visible cross-theme change, not a
	// hover state. The colour swap is deliberately instant — no `transition-colors`
	// here, even though the table rows carry one.
	return (
		<button
			type="button"
			onClick={handleClick}
			className={`flex w-full shrink-0 cursor-pointer items-center justify-center rounded-[2px] bg-[var(--color-primary)] font-['Sohne_Breit'] font-medium text-[var(--color-surface-base)] hover:text-[var(--color-quaternary)] ${sizing}`}
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{large ? (copied ? 'COPIED' : 'SHARE') : copied ? 'Copied' : 'Share'}
		</button>
	);
}

// The numeric half of a quote-per-base price. A stablecoin quote reads like
// dollars — 2 decimals — but only once the price is at or above $1: below that,
// 2 decimals gives too few significant digits (a $0.0113 memecoin price rounds
// to "0.01", a >10% error) so it falls back to 3 sig figs after the decimal, the
// same treatment sub-cent prices and every non-stablecoin quote already get via
// fractionDigitsForSigFigs. No separators, matching the token-amount display.
// Shared with the Price Delta row so the delta is formatted by the same rule as
// the prices it sits under.
export function formatPriceMagnitude(n: number, quoteSymbol?: string): string {
	const stableQuote = quoteSymbol != null && STABLE_SYMBOLS.has(quoteSymbol);
	const opts: Intl.NumberFormatOptions =
		stableQuote && Math.abs(n) >= 1
			? { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }
			: { useGrouping: false, maximumFractionDigits: fractionDigitsForSigFigs(n, 3) };
	return n.toLocaleString('en-US', opts);
}

export function formatExecutionPrice(value: unknown, baseSymbol = 'WETH', quoteSymbol?: string): string {
	const n = value == null ? null : Number(value);
	if (n == null || Number.isNaN(n)) return '–';
	const num = formatPriceMagnitude(n, quoteSymbol);
	const left = quoteSymbol ? `${num} ${quoteSymbol}` : num;
	return `${left} = 1 ${baseSymbol}`;
}

export function formatDialogBps(value: number | null): { text: string; color: string | undefined } {
	if (value == null || !Number.isFinite(value)) return { text: '–', color: undefined };
	const rounded = Number(value.toFixed(2));
	const text = rounded === 0 ? '0.00bps' : `${rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(2)}bps`;
	const color = rounded > 0 ? '#117d45' : undefined;
	return { text, color };
}

/**
 * Copy for the Slippage / Positive Slippage cells when we could not price every
 * leg. The percentage is deliberately user-facing: a trader should be able to
 * see how much of their transaction we actually priced.
 */
export function noSlippageTooltip(coveragePercent: number): string {
	return `No calculation available, per-leg pricing coverage is ${coveragePercent}% complete`;
}

/**
 * The address to link a route leg to on Basescan.
 *
 * A synthesized Uniswap V4 leg's `venue` is `v4:<poolId>` — a pool identifier,
 * not an address — so linking to it yields a dead URL. Those legs carry the
 * singleton that emitted their Swap in `v4Emitter`; link to that instead. Every
 * other leg's venue IS its address. Rows persisted before 2026-07-30 have no
 * `v4Emitter` and keep their (still-dead) venue link until repopulated.
 */
export function legLinkAddress(leg: Pick<RouteLeg, 'venue' | 'v4Emitter'>): string {
	if (leg.v4Emitter) return leg.v4Emitter;
	// `inf:<poolId>` and `v4:<poolId>` venues are pool ids, not addresses.
	if (leg.venue.startsWith('inf:')) return INFINITY_CL_POOL_MANAGER_ADDRESS;
	return leg.venue;
}

/**
 * Copy for the Slippage / Positive Slippage cells when the ENTIRE route was
 * filled from market-maker inventory.
 *
 * An RFQ fill is quoted off-chain; there is no pool mid to measure it against,
 * so the cost genuinely cannot be split into components. That is a property of
 * how RFQ works, NOT a gap in our readers — and `noSlippageTooltip`'s coverage
 * figure would blame the tool for it. 7 of 62 receipts ($55,054, incl. id 36 at
 * $35,055) are wholly maker-filled.
 *
 * ⚠️ Reserved for WHOLLY-maker routes. A mixed route keeps the coverage string
 * even when its only unpriced leg is the maker one — see the reasoning in
 * getExecutionBreakdown.
 */
export const RFQ_UNATTRIBUTABLE_TOOLTIP = 'No calculation available due to market maker inventory.';

/** Copy for the Unattributed row's label. */
export const UNATTRIBUTED_TOOLTIP =
	'Residual cost or benefit that could not be completely attributed to L.P. fees, aggregator fees, or price impact';

const NOT_AVAILABLE = { text: 'N/A', color: undefined };

export function getExecutionBreakdown(row: { slippageBps: string | number | null; routeLegs?: unknown }): {
	executionDisplay: { text: string; color: string | undefined };
	priceImpactDisplay: { text: string; color: string | undefined };
	/**
	 * @deprecated Do NOT render this. It is the UNGATED residual — the signed
	 * `slippage − Σ legPI` with no check that every leg was actually priced.
	 * Displaying it re-introduces exactly the overclaim this module exists to
	 * remove: on a partially-priced route it reads as a precise measurement of
	 * a quantity we never measured. Use `slippageDisplay` /
	 * `positiveSlippageDisplay` / `unattributedDisplay`, which are gated on
	 * `fullyPriced`. Retained only because a unit test still pins its value;
	 * it has had no production consumer since the trades table split its
	 * Slippage column in three.
	 */
	marketForcesDisplay: { text: string; color: string | undefined };
	slippageDisplay: { text: string; color: string | undefined };
	positiveSlippageDisplay: { text: string; color: string | undefined };
	unattributedDisplay: { text: string; color: string | undefined };
	coveragePercent: number;
	fullyPriced: boolean;
	residualRawBps: number | null;
	/** Explanation for the N/A Slippage cells; undefined when the route is priced. */
	slippageUnavailableTooltip: string | undefined;
} {
	const executionRaw =
		row.slippageBps == null || !Number.isFinite(Number(row.slippageBps))
			? null
			: Number(row.slippageBps);
	const legs = normalizeRouteLegs(row.routeLegs);
	const hasPriceImpact = legs.some((leg) => leg.priceImpactBps != null);
	const priceImpactRaw = hasPriceImpact
		? legs.reduce((sum, leg) => sum + (leg.priceImpactBps ?? 0), 0)
		: null;
	const marketForcesRaw =
		executionRaw != null && priceImpactRaw != null ? executionRaw - priceImpactRaw : executionRaw;

	// marketForcesRaw > 0 is a cost to the user; < 0 is a benefit. Split so each
	// row only ever carries one side, with the other pinned to 0.00bps.
	const slippageCostRaw = marketForcesRaw == null ? null : Math.max(marketForcesRaw, 0);
	const slippageBenefitRaw = marketForcesRaw == null ? null : Math.min(marketForcesRaw, 0);

	// The residual above is CORRECT arithmetic either way — it is what is left
	// after every leg we could price. What changes below is only what we are
	// entitled to CALL it. "Slippage" claims we accounted for price impact; when
	// a leg went unpriced, the honest claim is "we could not attribute this".
	const fullyPriced = isFullyPriced(legs);
	const coverage = priceImpactCoverage(legs);
	// Floor, never round, so we cannot overstate coverage; and cap at 99 so a
	// route that is 100.0% by notional but still has an unpriced (zero-notional)
	// leg never reads "100% complete" next to an N/A. A null coverage means
	// nothing to weigh at all, which is 0% priced.
	const coveragePercent = fullyPriced ? 100 : Math.min(99, Math.floor(100 * (coverage ?? 0)));

	// WHY we could not price it decides what we tell the trader. The maker
	// explanation is reserved for routes that are ENTIRELY market-maker fills —
	// there, no part of the trade ever touched a pool and a coverage percentage
	// would blame our tooling for how RFQ works.
	// ⚠️ "every UNPRICED leg is a maker" is NOT the right test, even though it
	// looks equivalent. On a mixed route like id 210 (one maker leg among six,
	// 77% of the notional priced through pools) it would claim the whole trade
	// was maker-filled. The coverage figure is the more informative and more
	// honest statement there.
	// ⚠️ `[].every()` is vacuously true: a route we never decomposed is a coverage
	// gap, not evidence of a market maker — hence the length check.
	const costed = costedLegs(legs);
	const routeIsAllMaker = costed.length > 0 && costed.every(isMakerLeg);
	const slippageUnavailableTooltip = fullyPriced
		? undefined
		: routeIsAllMaker
			? RFQ_UNATTRIBUTABLE_TOOLTIP
			: noSlippageTooltip(coveragePercent);

	const residualDisplay = formatDialogBps(marketForcesRaw == null ? null : -marketForcesRaw);

	return {
		executionDisplay: formatDialogBps(executionRaw == null ? null : -executionRaw),
		priceImpactDisplay: formatDialogBps(priceImpactRaw == null ? null : -priceImpactRaw),
		marketForcesDisplay: residualDisplay,
		slippageDisplay: fullyPriced
			? formatDialogBps(slippageCostRaw == null ? null : -slippageCostRaw)
			: NOT_AVAILABLE,
		positiveSlippageDisplay: fullyPriced
			? formatDialogBps(slippageBenefitRaw == null ? null : -slippageBenefitRaw)
			: NOT_AVAILABLE,
		unattributedDisplay: fullyPriced ? NOT_AVAILABLE : residualDisplay,
		slippageUnavailableTooltip,
		coveragePercent,
		fullyPriced,
		// Unnegated (positive = cost to the user). Exposed because the display
		// strings above have had their sign stripped by formatDialogBps and the
		// trades-table sort needs it back. Callers negate for display polarity.
		residualRawBps: marketForcesRaw,
	};
}

const NATIVE = 'native';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

/**
 * Resolves a leg's tokenIn/tokenOut to a display symbol for a Cost Breakdown
 * "context" string, correcting two ways the static TOKEN_SYMBOLS map (which
 * doesn't contain every token) can mislabel a leg:
 *
 *  1. Endpoint tokens: when a leg's token is the receipt's own resolved input
 *     or output token (e.g. WARP — absent from the static map), prefer the
 *     receipt's own inputSymbol/outputSymbol over the static map/short-address
 *     fallback.
 *  2. Terminal native-ETH legs: core's decomposeRoute models any native ETH
 *     value transfer using the WETH address internally, so an ERC-20-only
 *     route graph can chain native-settled legs (e.g. a Uniswap v4 pool that
 *     pays ETH directly). When a separate `unwrap` step follows, that WETH
 *     label is correct — the pool really did trade WETH, and the unwrap row
 *     shows the ETH conversion. But when NO unwrap step follows (v4 paying
 *     native ETH straight to the taker), the WETH stand-in on the last leg
 *     IS the true, final settlement and should read as the receipt's own
 *     outputSymbol (e.g. ETH), not WETH. Symmetric on the input side for a
 *     native-ETH-input trade with no leading `wrap` step.
 *
 * `index`/`legsLength` are the leg's position in the FULL route (before any
 * wrap/unwrap filtering), so the first/last native detection stays correct
 * even for callers (e.g. getPriceImpactRows) that filter step legs out.
 */
export function legPairContext(
	leg: Pick<RouteLeg, 'type' | 'tokenIn' | 'tokenOut' | 'tokenInSymbol' | 'tokenOutSymbol'>,
	index: number,
	legsLength: number,
	row: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>,
): string {
	const endpointSymbols = new Map<string, string>();
	if (row.inputToken && row.inputToken.toLowerCase() !== NATIVE) {
		endpointSymbols.set(row.inputToken.toLowerCase(), row.inputSymbol);
	}
	if (row.outputToken && row.outputToken.toLowerCase() !== NATIVE) {
		endpointSymbols.set(row.outputToken.toLowerCase(), row.outputSymbol);
	}
	// Prefer the symbol core resolved + stored on the leg (covers intermediate
	// hop tokens like USDT); then the receipt's own endpoints (for rows persisted
	// before leg symbols existed); then the static map / short address.
	const resolve = (address: string, stored?: string): string =>
		stored ?? endpointSymbols.get(address.toLowerCase()) ?? tokenSymbol(address);

	const isFirst = index === 0;
	const isLast = index === legsLength - 1;
	const inputIsNativeStandIn =
		isFirst &&
		leg.type !== 'wrap' &&
		row.inputToken?.toLowerCase() === NATIVE &&
		leg.tokenIn?.toLowerCase() === WETH_ADDRESS;
	const outputIsNativeStandIn =
		isLast &&
		leg.type !== 'unwrap' &&
		row.outputToken?.toLowerCase() === NATIVE &&
		leg.tokenOut?.toLowerCase() === WETH_ADDRESS;

	const inSymbol = inputIsNativeStandIn ? row.inputSymbol : resolve(leg.tokenIn, leg.tokenInSymbol);
	const outSymbol = outputIsNativeStandIn ? row.outputSymbol : resolve(leg.tokenOut, leg.tokenOutSymbol);
	return `${inSymbol}/${outSymbol}`;
}

export function getPriceImpactRows(
	legs: Pick<RouteLeg, 'venue' | 'type' | 'tokenIn' | 'tokenOut' | 'priceImpactBps' | 'tokenInSymbol' | 'tokenOutSymbol' | 'router' | 'feeResolved'>[],
	row?: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>,
): {
	label: string;
	href: string;
	context: string;
	value: string;
	color: string | undefined;
	valueTooltip?: string | undefined;
	router?: RouteLeg['router'];
}[] {
	return legs.map((leg, index) => {
		const stepContext = getStepContext(leg.type);
		if (stepContext) {
			return {
				label: getVenueLabel(leg),
				href: `https://basescan.org/address/${legLinkAddress(leg)}`,
				context: stepContext,
				value: '–',
				color: undefined,
				valueTooltip: undefined,
			};
		}
		const rawImpact = leg.priceImpactBps;
		const isNullImpact = rawImpact == null;
		const impact = isNullImpact
			? { text: 'N/A', color: undefined }
			: formatDialogBps(-rawImpact);
		return {
			label: getVenueLabel(leg),
			href: `https://basescan.org/address/${legLinkAddress(leg)}`,
			context: row
				? legPairContext(leg, index, legs.length, row)
				: `${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`,
			value: impact.text,
			color: impact.color,
			// A null impact keeps its own explanation — there is no number to
			// caveat. Otherwise, if this leg's fee tier never resolved, the number
			// shown here has ABSORBED that unread fee (see IMPACT_ABSORBS_FEE_TOOLTIP)
			// and must not read as a clean price-impact measurement.
			valueTooltip: isNullImpact
				? getNullPriceImpactTooltip(leg)
				: hasUnresolvedFee(leg)
					? IMPACT_ABSORBS_FEE_TOOLTIP
					: undefined,
			router: leg.router,
		};
	});
}

// Shared with ReceiptView's LP-fee tooltip (imported from here) so the two
// null-cell explanations for an rfq leg — Price Impact here, LP Fee there —
// state the same, current semantics: an rfq leg's price impact and LP fee
// are null BY DESIGN (off-chain quote, no on-chain mid), never because a mid
// was "discovered ... implausible or stale" (that failure mode no longer exists).
export const RFQ_LEG_TOOLTIP =
	'Market maker inventory, no L.P. fee or price available for this leg';

/** True when a leg is a market maker's off-chain-quoted fill, not an on-chain pool. */
export function isMakerLeg(leg: Pick<RouteLeg, 'type' | 'venue'>): boolean {
	// `venue` is optional-in-practice: route_legs is persisted JSON, and callers
	// pass partial legs. An absent venue is never in the exclusion set, so it
	// falls through to "maker" — the same answer the type alone would give.
	return leg.type === 'rfq' && !KNOWN_NON_RFQ_VENUES.has((leg.venue ?? '').toLowerCase());
}

// Shared with ReceiptView for every other null-pricing field (Market Price,
// Price Delta, Price Impact, Slippage) so the "no data" explanation reads the
// same everywhere it's not the market-maker-specific case above.
export const NULL_PRICE_TOOLTIP = 'No market price available';

// A fee tier core could not read. Distinct from the null/rfq cases above: the
// pool DOES charge an LP fee, we just failed to resolve it — so the cell must
// not render "0.00bps", which would assert the pool was free. Reads as the
// fee-side counterpart to LEG_NULL_PRICE_TOOLTIP.
export const UNRESOLVED_FEE_TOOLTIP = 'No fee available for this leg';

// The SAME unresolved fee, seen from the Price Impact row. An unread tier books
// as 0, and core derives price impact as (legTotalCost − feeTier) × share
// (decomposeRoute.ts:374, :632) while LP fee is feeTier × the SAME share (:566).
// So the fee we failed to read has not vanished — it is sitting inside this
// leg's price impact, which would otherwise render as a clean measurement.
//
// ⚠️ This does NOT reach the Slippage / Unattributed residual. Core computes
// `slippage = allIn − lpFee − aggFee` (:577), so an understated lpFee overstates
// slippage by exactly the amount it overstates ΣPI — and the displayed residual
// `slippage − ΣPI` is invariant. Do not extend the coverage gate to fee
// provenance on the strength of this: the residual really is fully attributed;
// it is only the LP-Fee-vs-Price-Impact SPLIT that is wrong, and both of those
// rows are on screen.
export const IMPACT_ABSORBS_FEE_TOOLTIP = 'Includes the unavailable L.P. fee for this leg';

/**
 * True when NO leg of this route can contribute a readable L.P. fee, so the
 * route-level rollup is a sum of nothing and must render `–` rather than 0.
 *
 * A missing fee must not sum to zero. Two ways that happens:
 *  - a maker-only route: an rfq leg carries `lpFeeBps: 0` BY DESIGN (there is no
 *    pool fee to read), so the rollup aggregates to a misleading 0.0bps;
 *  - every pool leg's fee tier failed to read (`feeResolved: false`), which
 *    booked receipt id 78 as `L.P. Fee = 0.0bps` on a $1,919 trade routed
 *    entirely through two pools that certainly charge one.
 *
 * ⚠️ Requires EVERY fee-bearing leg to be unreadable. A route with even one
 * resolved leg keeps its number: it is understated, not false, and blanking it
 * would discard real measurement. (id 75 is that case — four small legs read,
 * two large ones not.) The per-leg rows carry their own `–` and tooltip either
 * way, so nothing is hidden; this only governs the rollup.
 *
 * ⚠️ wrap/unwrap are excluded — they carry `lpFeeBps: null` by nature, and
 * counting them as non-contributors would make every wrapped route look
 * unreadable.
 */
export function hasNoReadableLpFee(
	legs: Pick<RouteLeg, 'type' | 'venue' | 'lpFeeBps' | 'feeResolved'>[],
): boolean {
	const contributors = legs.filter(
		(l) => l.type !== 'wrap' && l.type !== 'unwrap' && !isMakerLeg(l),
	);
	// No pool legs at all: unreadable precisely when a maker filled the route.
	if (contributors.length === 0) return legs.some(isMakerLeg);
	return contributors.every((l) => l.feeResolved === false || typeof l.lpFeeBps !== 'number');
}

/** True when core explicitly marked this leg's fee tier unresolved. */
export function hasUnresolvedFee(leg: Pick<RouteLeg, 'feeResolved'>): boolean {
	return leg.feeResolved === false;
}

// Per-leg null-pricing cells (a specific route leg's Price Impact) get a
// leg-scoped explanation, distinct from the receipt-level NULL_PRICE_TOOLTIP
// used by Market Price / Price Delta / Slippage.
export const LEG_NULL_PRICE_TOOLTIP = 'No price available for this leg';

function getNullPriceImpactTooltip(leg: Pick<RouteLeg, 'type' | 'venue'>): string {
	if (isMakerLeg(leg)) return RFQ_LEG_TOOLTIP;
	return LEG_NULL_PRICE_TOOLTIP;
}

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const TOKEN_SYMBOLS: Record<string, string> = {
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
	'0x4200000000000000000000000000000000000006': 'WETH',
	'0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
	'0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
	'0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
	'0x0555e30da8f98308edb960aa94c0db47230d2b9c': 'WBTC',
	'0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
	'0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
	'0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 'EURC',
	'0xa1f72459dfa10bad200ac160ecd78c6b77a747be': 'CLAWNCH',
	'0x7d928816cc9c462dd7adef911de41535e444cb07': 'FAIR',
	'0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07': 'CLAWD',
	'0x3722264ab15a1dfce5a5af89e6547f7949a8aba3': 'LFI',
	'0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3': 'GITLAWB',
};

// Infinity's CLPoolManager — the contract that actually emits Swap and holds
// per-pool state, as opposed to PANCAKE_INFINITY_VAULT (the token custodian).
// `inf:<poolId>` legs link here since the poolId itself is not an address.
const INFINITY_CL_POOL_MANAGER_ADDRESS = '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b';

// Consulted BEFORE any leg.type dispatch, so a venue can be named without
// giving it a VenueType. That matters for singleton custodians: naming them
// here is purely cosmetic, whereas a new VenueType changes which branch
// getLegMidAtBlock takes and can null the leg's price impact.
const KNOWN_VENUE_LABELS: Record<string, string> = {
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969': 'Curve StableNG',
	'0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap v4',
	'0xb1383dc47d9971fc999c3a9088f79e744b376e97': 'Hydrex',
	'0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76': 'UniPool',
	// PancakeSwap Infinity's Vault — the collapsed (un-rescued) leg's venue when
	// per-pool synthesis did not fire. Named for the protocol, matching Uniswap
	// v4 above, which is likewise the singleton rather than the pool the trade
	// touched. `getVenueLabel`'s `pancake_infinity` type case covers the
	// synthesized `inf:<poolId>` legs, whose venue is a pool id, not this address.
	'0x238a358808379702088667322f80ac48bad5e6c4': 'PancakeSwap Infinity',
};

const KNOWN_NON_RFQ_VENUES = new Set([
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969',
]);

export function tokenSymbol(address: string): string {
	return TOKEN_SYMBOLS[address.toLowerCase()] ?? shortAddress(address);
}

export function normalizeRouteLegs(routeLegs: unknown): RouteLeg[] {
	if (Array.isArray(routeLegs)) return routeLegs as RouteLeg[];
	if (typeof routeLegs !== 'string') return [];
	try {
		const parsed = JSON.parse(routeLegs);
		return Array.isArray(parsed) ? parsed as RouteLeg[] : [];
	} catch {
		return [];
	}
}

const ANCHOR_TOKEN_PREFIXES = ['BENEFICIARY_ANCHORED', 'ANCHOR_VIA_'];
const isAnchorToken = (flag: string): boolean => ANCHOR_TOKEN_PREFIXES.some((p) => flag.startsWith(p));

/** Human disclosure that a receipt was anchored on the beneficiary, not tx.from.
 *  null for ordinary self-anchored receipts. */
export function beneficiaryAnchorNote(row: Partial<Pick<ReceiptRow, 'normalizeFlags'>>): string | null {
	const flags = Array.isArray(row.normalizeFlags) ? row.normalizeFlags.filter((f): f is string => typeof f === 'string') : [];
	if (!flags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))) return null;
	if (flags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))) return 'Executed on your behalf via UniswapX';
	return 'Executed on your behalf by a solver';
}

/** True when this receipt should show the Filler row (UniswapX-anchored AND
 *  a fillerAddress was persisted) in place of the Aggregator row. Rows
 *  anchored via UniswapX before the fillerAddress column existed (null)
 *  fall back to the ordinary Aggregator row — see ReceiptView. */
export function isUniswapXFillerRow(row: Partial<Pick<ReceiptRow, 'normalizeFlags' | 'fillerAddress'>>): boolean {
	if (row.fillerAddress == null) return false;
	const flags = Array.isArray(row.normalizeFlags) ? row.normalizeFlags.filter((f): f is string => typeof f === 'string') : [];
	return flags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'));
}

export function getFlagLabel(row: Partial<Pick<ReceiptRow, 'normalizeFlags' | 'decompConfidence'>>): string {
	const flags = Array.isArray(row.normalizeFlags)
		? row.normalizeFlags.filter((flag): flag is string => typeof flag === 'string' && flag.trim().length > 0 && !isAnchorToken(flag))
		: [];
	return flags.length > 0 ? flags.join('; ') : 'None';
}

// Generalized token display: reads the input/output symbol + amount fields that
// exist on both `ReceiptRow` (ReceiptView) and the History dialog's adapter.
export function formatTokenIn(row: { inputSymbol: string; inputAmount: string | number }): string {
	return `${formatTokenAmount(row.inputAmount, row.inputSymbol)} ${row.inputSymbol}`;
}

export function formatTokenOut(row: { outputSymbol: string; outputAmount: string | number }): string {
	return `${formatTokenAmount(row.outputAmount, row.outputSymbol)} ${row.outputSymbol}`;
}

export function getVenueLabel(leg: Pick<RouteLeg, 'type'> & Partial<Pick<RouteLeg, 'venue'>>): string {
	const knownLabel = leg.venue ? KNOWN_VENUE_LABELS[leg.venue.toLowerCase()] : undefined;
	if (knownLabel) return knownLabel;
	if (leg.type === 'sushiv3') return 'SushiSwap v3';
	if (leg.type === 'baseswapv3') return 'BaseSwap v3';
	if (leg.type === 'aerodrome_cl') return 'Aerodrome SlipStream';
	if (leg.type === 'curve_stableng') return 'Curve StableNG';
	if (leg.type === 'maverickv1') return 'Maverick v1';
	if (leg.type === 'maverickv2') return 'Maverick v2';
	if (leg.type === 'hydrex') return 'Hydrex';
	if (leg.type === 'quickswapv4') return 'QuickSwap v4';
	if (leg.type === 'unipool') return 'UniPool';
	if (leg.type === 'aerodrome') return 'Aerodrome';
	if (leg.type === 'univ4') return 'Uniswap v4';
	if (leg.type === 'pancake_infinity') return 'PancakeSwap Infinity';
	if (leg.type === 'pancakev3') return 'PancakeSwap v3';
	if (leg.type === 'univ3') return 'Uniswap v3';
	if (leg.type === 'univ2') return 'Uniswap v2';
	if (leg.type === 'unwrap') return 'Unwrap';
	if (leg.type === 'wrap') return 'Wrap';
	if (leg.type === 'rfq') return 'Market Maker';
	if (leg.type === 'unknown') return 'Unknown Pool';
	return leg.type.toUpperCase();
}

// Wrap/unwrap rows show the ETH<->WETH conversion as a quaternary "context"
// string next to the label (matching every other leg row's label+context
// split) instead of baking it into the label itself.
export function getStepContext(legType: RouteLeg['type']): string | undefined {
	if (legType === 'wrap') return 'ETH → WETH';
	if (legType === 'unwrap') return 'WETH → ETH';
	return undefined;
}

// Fabric is the *router* for every trade routed through it, so any retained
// fee we detect there is really an integrator/partner's `feeBps` being
// forwarded to their `feeRecipient`, not Fabric's own revenue — label it
// neutrally as "Integrator Fee" and link out to the recipient's contract
// rather than naming or explaining it inline.
const FABRIC_AGGREGATOR_SLUG = 'fabric';

export interface FeeLine {
	label: string;
	href?: string;
	bps: number;
}

interface FeeSinkNamed {
	address: string;
	feeBps: number;
	source: string;
	name: string | null;
}

// Generic label for a fee whose recipient contract has no verified Basescan
// name. Fabric is only ever the *router*, so a retained fee there belongs to an
// integrator/partner — labeled neutrally as "Integrator Fee", never "Fabric Fee".
function genericFeeLabel(aggregator: string): string {
	if (aggregator.toLowerCase() === FABRIC_AGGREGATOR_SLUG) return 'Integrator Fee';
	return `${formatProvider(aggregator.toLowerCase())} Fee`;
}

// One clickable line per aggregator fee sink. A sink with a verified Basescan
// contract name is labeled with it, wherever it sits in the list. An UNNAMED
// sink falls back to the generic "[Aggregator] Fee" if it's the dominant
// (first) one, otherwise to its truncated address — a deliberate visual cue
// that the sink still needs curation/investigation. All sinks link to their
// Basescan address page.
export function getAggregatorFeeLines(row: {
	aggregator: string;
	aggFeeBps: string | number | null;
	feeRecipient?: string | null;
	feeSinks?: FeeSinkNamed[] | null;
}): FeeLine[] {
	const totalBps = Number(row.aggFeeBps ?? 0);
	if (!Number.isFinite(totalBps) || totalBps === 0) return [];

	const sinks: FeeSinkNamed[] =
		row.feeSinks && row.feeSinks.length > 0
			? row.feeSinks
			: row.feeRecipient
				? [{ address: row.feeRecipient, feeBps: totalBps, source: 'retained_balance', name: null }]
				: [];

	if (sinks.length === 0) {
		// Fee detected but no recipient — show the generic label, unlinked.
		return [{ label: genericFeeLabel(row.aggregator), bps: totalBps }];
	}

	return sinks.map((s, i) => ({
		label: s.name ?? (i === 0 ? genericFeeLabel(row.aggregator) : shortTxHash(s.address)),
		href: `https://basescan.org/address/${s.address}`,
		bps: s.feeBps,
	}));
}

export function tokenUnitPriceUsd(
	notionalUsd: string | number | null | undefined,
	amount: string | number | null | undefined,
): number | null {
	const notional = notionalUsd == null ? null : Number(notionalUsd);
	const amt = amount == null ? null : Number(amount);
	if (notional == null || amt == null || !Number.isFinite(notional) || !Number.isFinite(amt) || amt <= 0) {
		return null;
	}
	return notional / amt;
}

// Re-exported from receipt/symbols.ts (a leaf module) so existing external
// consumers of TradesTable's STABLE_SYMBOLS / ETH_SYMBOLS keep working unchanged.
export { STABLE_SYMBOLS, ETH_SYMBOLS };

// The whole part is always shown in full — never rounded away — only the
// fractional part is capped, at `sigFigs` significant digits. Leading zeros
// right after the decimal point don't count against that cap, so a sub-cent
// dust amount still renders with real precision instead of collapsing toward
// zero. Shared by formatTokenAmount and formatPriceMagnitude so token amounts,
// Execution/Market Price, and (non-USD-anchored) Price Delta all round the
// same way.
function fractionDigitsForSigFigs(n: number, sigFigs: number): number {
	const frac = Math.abs(n) % 1;
	if (frac === 0) return 0;
	const leadingZeros = Math.max(0, -Math.floor(Math.log10(frac)) - 1);
	return leadingZeros + sigFigs;
}

// Stablecoins are dollar-denominated, so they render exactly 2 decimals
// (currency style, padded) regardless of magnitude. No separators either way.
export function formatTokenAmount(amount: string | number, symbol?: string): string {
	const n = Number(amount);
	if (!Number.isFinite(n)) return String(amount);
	if (symbol != null && STABLE_SYMBOLS.has(symbol)) {
		return n.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}
	return n.toLocaleString('en-US', {
		useGrouping: false,
		maximumFractionDigits: fractionDigitsForSigFigs(n, 3),
	});
}
