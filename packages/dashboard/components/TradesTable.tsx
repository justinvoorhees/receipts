'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ReceiptRow, RouteLeg, TradesSort, TradesSortColumn } from '../lib/queries';
import {
	formatContribution,
	formatNotional,
	formatProvider,
	providerColor,
} from '../lib/formatters';
import { Receipt } from './ReceiptView';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './receipt/symbols';
import { formatUsdMagnitude } from './receipt/usdFormat';

const COL = 'p-0 py-[10px] pl-[28px] align-baseline';
const COL_FIRST = 'p-0 py-[10px] align-baseline';

const ACCESSORS: Record<TradesSortColumn, (r: ReceiptRow) => string | number> = {
	block: (r) => r.blockNumber,
	aggregator: (r) => r.aggregator.toLowerCase(),
	// "side" = input→output symbols; we never parse `direction`.
	side: (r) => `${r.inputSymbol}->${r.outputSymbol}`,
	size: (r) => Number(r.notionalUsd ?? 0),
	accuracy: (r) => -Number(r.allInCostBps ?? 0),
	lpFee: (r) => -Number(r.lpFeeBps ?? 0),
	aggFee: (r) => -Number(r.aggFeeBps ?? 0),
	impact: (r) => {
		const legs = normalizeRouteLegs(r.routeLegs);
		const hasPriceImpact = legs.some((l) => l.priceImpactBps != null);
		return hasPriceImpact ? -legs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0) : 0;
	},
	slippage: (r) => {
		const slip = r.slippageBps == null ? null : Number(r.slippageBps);
		const legs = normalizeRouteLegs(r.routeLegs);
		const hasPriceImpact = legs.some((l) => l.priceImpactBps != null);
		const impact = hasPriceImpact ? legs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0) : null;
		const residual = slip != null && impact != null ? slip - impact : slip;
		return -(residual ?? 0);
	},
	gas: (r) => Number(r.gasCostUsd ?? 0),
};

export function TradesTable({
	rows,
	initialSort,
	onDelete,
}: {
	rows: ReceiptRow[];
	initialSort: TradesSort;
	onDelete?: (id: number) => void;
}) {
	const router = useRouter();
	const [sort, setSort] = useState<TradesSort | null>(null);
	const [selectedRow, setSelectedRow] = useState<ReceiptRow | null>(null);
	const effectiveSort = sort ?? initialSort;

	const sortedRows = useMemo(() => {
		const access = ACCESSORS[effectiveSort.column];
		const mul = effectiveSort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const av = access(a);
			const bv = access(b);
			if (av < bv) return -mul;
			if (av > bv) return mul;
			return b.blockNumber - a.blockNumber;
		});
	}, [rows, effectiveSort]);

	// Delete: confirm, then either defer to an injected handler (tests) or hit
	// the DELETE route and refresh the server-rendered list. Returns whether the
	// delete proceeded, so callers (e.g. the dialog) know whether to close.
	const handleDelete = async (id: number): Promise<boolean> => {
		if (typeof window !== 'undefined' && !window.confirm('Delete this receipt?')) return false;
		if (onDelete) {
			onDelete(id);
			return true;
		}
		await fetch(`/api/receipts?id=${id}`, { method: 'DELETE' });
		router.refresh();
		return true;
	};

	const onSort = (col: TradesSortColumn) => {
		let next: TradesSort | null;
		if (sort === null || sort.column !== col) {
			next = { column: col, direction: 'asc' };
		} else if (sort.direction === 'asc') {
			next = { column: col, direction: 'desc' };
		} else {
			next = null;
		}
		setSort(next);
		if (typeof window !== 'undefined') {
			const url = new URL(window.location.href);
			if (next === null) {
				url.searchParams.delete('sort');
				url.searchParams.delete('dir');
			} else {
				url.searchParams.set('sort', next.column);
				url.searchParams.set('dir', next.direction);
			}
			window.history.replaceState(null, '', url.toString());
		}
	};

	return (
		<div className="mt-[40px]">
			<table className="w-full font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<thead>
					<HeaderRow sort={sort} onSort={onSort} />
				</thead>
				<tbody>
					{sortedRows.map((r) => (
						<DataRow key={r.id} row={r} onOpen={setSelectedRow} />
					))}
				</tbody>
			</table>
			{selectedRow != null && (
				<TransactionDetailsDialog row={selectedRow} onClose={() => setSelectedRow(null)} onDelete={handleDelete} />
			)}
		</div>
	);
}

function HeaderRow({
	sort,
	onSort,
}: {
	sort: TradesSort | null;
	onSort: (col: TradesSortColumn) => void;
}) {
	const TH = 'p-0 pb-[10px] pl-[28px] align-baseline font-medium text-right';
	const TH_FIRST = 'p-0 pb-[10px] align-baseline font-medium text-left';
	return (
		<tr className="text-[var(--color-secondary)] uppercase font-medium">
			<th className={TH_FIRST}>
				<SortHeader col="aggregator" sort={sort} onSort={onSort} align="left">Aggregator</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="size" sort={sort} onSort={onSort}>Size</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="lpFee" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-lp-fee', text: 'Fees paid to liquidity providers' }}>L.P. Fee</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="aggFee" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-agg-fee', text: 'Fees paid to aggregators' }}>Agg. Fee</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="impact" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-impact', text: 'Per-venue delta between execution price and the prior-block mid, excluding L.P. Fee' }}>P. IMPACT</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="slippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-slippage', text: 'Residual execution difference after L.P. Fee, Agg. Fee, and P. Impact' }}>Slippage</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="accuracy" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-accuracy', text: 'Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage' }}>EX. QUALITY</SortHeader>
			</th>
		</tr>
	);
}

function SortHeader({
	col,
	sort,
	onSort,
	className,
	align = 'right',
	tooltip,
	children,
}: {
	col: TradesSortColumn;
	sort: TradesSort | null;
	onSort: (col: TradesSortColumn) => void;
	className?: string;
	align?: 'left' | 'right';
	tooltip?: { id: string; text: string };
	children: React.ReactNode;
}) {
	const active = sort?.column === col;
	const arrow = active ? (sort!.direction === 'desc' ? ' ↓' : ' ↑') : '';
	return (
		<button
			type="button"
			onClick={() => onSort(col)}
			style={{ textAlign: align }}
			aria-describedby={tooltip?.id}
			className={`underline underline-offset-[2px] [text-decoration-skip-ink:none] whitespace-nowrap text-inherit font-inherit uppercase cursor-pointer hover:text-[var(--color-primary)] hover:decoration-solid ${
				active ? 'text-[var(--color-primary)] decoration-solid' : 'decoration-dotted'
			} ${tooltip ? 'group relative' : ''} ${className ?? ''}`}
		>
			{children}
			{arrow}
			{tooltip && (
				<div
					role="tooltip"
					id={tooltip.id}
					className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-[8px] w-max max-w-[320px] -translate-x-1/2 rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal not-italic normal-case whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible group-focus-visible:visible"
				>
					{tooltip.text}
				</div>
			)}
		</button>
	);
}

// Strips a leading '-' so table cells show magnitude only; color already
// conveys cost (uncolored) vs. surplus (green).
function stripSign(text: string): string {
	return text.replace(/^-/, '');
}

// Execution column: magnitude only, but with a leading '+' on positive
// (surplus) values to distinguish them from costs at a glance.
function formatAccuracySigned(costBps: number): string {
	const accuracy = -costBps;
	const rounded = Number(accuracy.toFixed(1));
	if (rounded === 0) return '0.0bps';
	return `${rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(1)}bps`;
}

function DataRow({
	row,
	onOpen,
}: {
	row: ReceiptRow;
	onOpen: (row: ReceiptRow) => void;
}) {
	// Partial receipts have no cost model, so guard every cost field and render "–".
	const costBps = row.allInCostBps != null ? Number(row.allInCostBps) : null;
	const accuracy = costBps == null ? null : -costBps;
	const accuracyColor = accuracy != null && accuracy > 0.05 ? '#117d45' : undefined;

	const lp = formatContribution(row.lpFeeBps != null ? Number(row.lpFeeBps) : null);
	const agg = formatContribution(row.aggFeeBps != null ? Number(row.aggFeeBps) : null);
	const execution = getExecutionBreakdown(row);
	const impact = execution.priceImpactDisplay;
	const slip = execution.marketForcesDisplay;

	return (
		<tr
			className="group cursor-pointer text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-low)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-focus)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
			onClick={() => onOpen(row)}
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } }}
		>
			<td className={COL_FIRST} style={{ color: providerColor(row.aggregator.toLowerCase()) }}>{formatProvider(row.aggregator.toLowerCase())}</td>
			<td className={`${COL} text-right`}>{formatNotional(row.notionalUsd != null ? Number(row.notionalUsd) : null)}</td>
			<td className={`${COL} text-right`} style={lp.color ? { color: lp.color } : undefined}>{stripSign(lp.text)}</td>
			<td className={`${COL} text-right`} style={agg.color ? { color: agg.color } : undefined}>{stripSign(agg.text)}</td>
			<td className={`${COL} text-right`} style={impact.color ? { color: impact.color } : undefined}>{impact.text}</td>
			<td className={`${COL} text-right`} style={slip.color ? { color: slip.color } : undefined}>{slip.text}</td>
			<td className={`${COL} text-right`} style={accuracyColor ? { color: accuracyColor } : undefined}>{costBps == null ? '–' : formatAccuracySigned(costBps)}</td>
		</tr>
	);
}

/**
 * Row-click receipt dialog. The body is the same generalized `Receipt`
 * rendering used by the /receipts page (Task 10), so the two never drift.
 * This component only owns the modal shell: scrim, scroll-lock, Escape /
 * click-outside close, and the close button.
 */
export function TransactionDetailsDialog({
	row,
	onClose,
	onDelete,
}: {
	row: ReceiptRow;
	onClose: () => void;
	onDelete: (id: number) => Promise<boolean>;
}) {
	const handleDelete = async () => {
		if (await onDelete(row.id)) onClose();
	};

	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = prev; };
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	return (
		<div className="fixed inset-0 z-layer-dialog-scrim overflow-y-auto bg-[rgba(15,15,15,0.20)] backdrop-blur-[2px]">
			<div
				className="flex min-h-full items-stretch justify-center px-[20px]"
				role="presentation"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) onClose();
				}}
			>
				<section
					role="dialog"
					aria-modal="true"
					aria-label="Transaction receipt"
					className="relative flex w-full max-w-[720px] flex-col gap-[40px] bg-[var(--color-surface-base)] px-[40px] pt-[40px] pb-[40px] text-[var(--color-primary)] shadow-[8px_0px_8px_rgba(15,15,15,0.06),-8px_0px_8px_rgba(15,15,15,0.06)]"
				>
					<Receipt row={row} sharePath={`/receipts?tx=${row.txHash}`} onClose={onClose} onDelete={handleDelete} />
				</section>
			</div>
		</div>
	);
}

export function formatSubvalueUsd(value: number): string {
	const mag = formatUsdMagnitude(value);
	return mag == null ? '–' : `$${mag}`;
}

// Re-exported from receipt/usdFormat.ts (a leaf module) so existing external
// consumers of TradesTable's formatUsdMagnitude keep working unchanged.
export { formatUsdMagnitude };

export function ShareButton({ path }: { path?: string } = {}) {
	const [copied, setCopied] = useState(false);

	const handleClick = async () => {
		const url = path != null ? new URL(path, window.location.origin).toString() : window.location.href;
		await navigator.clipboard.writeText(url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className="flex h-[40px] w-full shrink-0 cursor-pointer items-center justify-center rounded-[2px] bg-[var(--color-primary)] px-[8px] font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] text-[var(--color-surface-base)]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{copied ? 'Copied' : 'Share'}
		</button>
	);
}

// The numeric half of a quote-per-base price. A stablecoin quote reads like
// dollars — 2 decimals — but falls back to 6 sig figs when sub-cent so a tiny
// memecoin price doesn't collapse to 0.00. Any other quote uses 6 sig figs. No
// separators, matching the token-amount display. Shared with the Price Delta row
// so the delta is formatted by the same rule as the prices it sits under.
export function formatPriceMagnitude(n: number, quoteSymbol?: string): string {
	const stableQuote = quoteSymbol != null && STABLE_SYMBOLS.has(quoteSymbol);
	const opts: Intl.NumberFormatOptions =
		stableQuote && Math.abs(n) >= 0.01
			? { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }
			: { useGrouping: false, maximumSignificantDigits: 6 };
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

export function getExecutionBreakdown(row: { slippageBps: string | number | null; routeLegs?: unknown }): {
	executionDisplay: { text: string; color: string | undefined };
	priceImpactDisplay: { text: string; color: string | undefined };
	marketForcesDisplay: { text: string; color: string | undefined };
	slippageDisplay: { text: string; color: string | undefined };
	positiveSlippageDisplay: { text: string; color: string | undefined };
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

	return {
		executionDisplay: formatDialogBps(executionRaw == null ? null : -executionRaw),
		priceImpactDisplay: formatDialogBps(priceImpactRaw == null ? null : -priceImpactRaw),
		marketForcesDisplay: formatDialogBps(marketForcesRaw == null ? null : -marketForcesRaw),
		slippageDisplay: formatDialogBps(slippageCostRaw == null ? null : -slippageCostRaw),
		positiveSlippageDisplay: formatDialogBps(slippageBenefitRaw == null ? null : -slippageBenefitRaw),
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
	legs: Pick<RouteLeg, 'venue' | 'type' | 'tokenIn' | 'tokenOut' | 'priceImpactBps' | 'tokenInSymbol' | 'tokenOutSymbol'>[],
	row?: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>,
): {
	label: string;
	href: string;
	context: string;
	value: string;
	color: string | undefined;
	valueTooltip?: string | undefined;
}[] {
	return legs.map((leg, index) => {
		const stepContext = getStepContext(leg.type);
		if (stepContext) {
			return {
				label: getVenueLabel(leg),
				href: `https://basescan.org/address/${leg.venue}`,
				context: stepContext,
				value: '–',
				color: undefined,
				valueTooltip: undefined,
			};
		}
		const rawImpact = leg.priceImpactBps;
		const isNullImpact = rawImpact == null;
		const impact = isNullImpact
			? { text: 'Null', color: undefined }
			: formatDialogBps(-rawImpact);
		return {
			label: getVenueLabel(leg),
			href: `https://basescan.org/address/${leg.venue}`,
			context: row
				? legPairContext(leg, index, legs.length, row)
				: `${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`,
			value: impact.text,
			color: impact.color,
			valueTooltip: isNullImpact ? getNullPriceImpactTooltip(leg) : undefined,
		};
	});
}

// Shared with ReceiptView's LP-fee tooltip (imported from here) so the two
// null-cell explanations for an rfq leg — Price Impact here, LP Fee there —
// state the same, current semantics: an rfq leg's price impact and LP fee
// are null BY DESIGN (off-chain quote, no on-chain mid), never because a mid
// was "discovered ... implausible or stale" (that failure mode no longer exists).
export const RFQ_LEG_TOOLTIP = 'Market maker inventory, no L.P. fee or market price available';

/** True when a leg is a market maker's off-chain-quoted fill, not an on-chain pool. */
export function isMakerLeg(leg: Pick<RouteLeg, 'type' | 'venue'>): boolean {
	return leg.type === 'rfq' && !KNOWN_NON_RFQ_VENUES.has(leg.venue.toLowerCase());
}

// Shared with ReceiptView for every other null-pricing field (Market Price,
// Price Delta, Price Impact, Slippage) so the "no data" explanation reads the
// same everywhere it's not the market-maker-specific case above.
export const NULL_PRICE_TOOLTIP = 'No market price available';

function getNullPriceImpactTooltip(leg: Pick<RouteLeg, 'type' | 'venue'>): string {
	if (isMakerLeg(leg)) return RFQ_LEG_TOOLTIP;
	return NULL_PRICE_TOOLTIP;
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

const KNOWN_VENUE_LABELS: Record<string, string> = {
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969': 'Curve StableNG',
	'0x3eb210eaa4026f62d027fafaba1fa5592febb06a': 'Fabric OTC',
	'0x69e68e18f53889bdc7589e9f2defbf88e2d32de7': 'Fabric OTC',
	'0x73f0859f844f042cd699f35bb5fe13a120f95c0f': 'Fabric OTC',
	'0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap v4',
	'0xb94b22332abf5f89877a14cc88f2abc48c34b3df': 'Fabric OTC',
	'0xb1383dc47d9971fc999c3a9088f79e744b376e97': 'Hydrex',
	'0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76': 'UniPool',
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

export function routePath(legs: RouteLeg[]): string {
	const swaps = legs.filter((l) => l.type !== 'wrap' && l.type !== 'unwrap');
	if (swaps.length === 0) return '–';
	const tokens = [tokenSymbol(swaps[0]!.tokenIn), ...swaps.map((leg) => tokenSymbol(leg.tokenOut))];
	return tokens.join('->');
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
	if (leg.type === 'unipool') return 'UniPool';
	if (leg.type === 'aerodrome') return 'Aerodrome';
	if (leg.type === 'univ4') return 'Uniswap v4';
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

function aggregatorFeeLabel(row: { aggregator: string; aggFeeBps: string | number | null }): string {
	const provider = formatProvider(row.aggregator.toLowerCase());
	const feeBps = Number(row.aggFeeBps ?? 0);
	if (feeBps === 0) return provider;
	if (row.aggregator.toLowerCase() === FABRIC_AGGREGATOR_SLUG) return 'Integrator Fee';
	return `${provider} Fee`;
}

export function getAggregatorFeeAttribution(row: { aggregator: string; aggFeeBps: string | number | null; feeRecipient?: string | null }): {
	label: string;
	href?: string | undefined;
} {
	const vaults: Record<string, { label: string; href: string }> = {
		velora: {
			label: 'Augustus Fee Vault',
			href: 'https://basescan.org/address/0x00700052c0608F670705380a4900e0a8080010CC',
		},
		relay: {
			label: 'Relay: Solver',
			href: 'https://basescan.org/address/0xf70da97812CB96acDF810712Aa562db8dfA3dbEF',
		},
		kyberswap: {
			label: 'KyberSwap Fee Sink',
			href: 'https://basescan.org/address/0x4f82e73edb06d29ff62c91ec8f5ff06571bdeb29',
		},
	};
	const tagged = vaults[row.aggregator.toLowerCase()];
	if (tagged) return tagged;
	const label = aggregatorFeeLabel(row);
	if (label === 'Integrator Fee') {
		// Link to the persisted feeRecipient (the integrator's fee wallet) when available.
		return { label, ...(row.feeRecipient ? { href: `https://basescan.org/address/${row.feeRecipient}` } : {}) };
	}
	return { label };
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
// fractional part is capped, at 6 significant digits. Leading zeros right after
// the decimal point don't count against that cap, so a sub-cent dust amount
// still renders with real precision instead of collapsing toward zero.
function fractionDigitsForSixSigFigs(n: number): number {
	const frac = Math.abs(n) % 1;
	if (frac === 0) return 0;
	const leadingZeros = Math.max(0, -Math.floor(Math.log10(frac)) - 1);
	return leadingZeros + 6;
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
		maximumFractionDigits: fractionDigitsForSixSigFigs(n),
	});
}
