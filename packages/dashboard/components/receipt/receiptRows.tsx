'use client';
/**
 * receiptRows — the presentational row/layout sub-components of the receipt
 * (DetailRow, the Cost-Breakdown rows, dividers, aggregator/filler rows). Split out
 * of ReceiptView.tsx (2026-07-21). No hooks; each takes props and renders JSX. Marked
 * 'use client' to match the receipt/ leaf convention.
 */
import { providerColor, formatProvider } from '../../lib/formatters';
import type { ReceiptRow, RouteLeg } from '../../lib/queries';
import {
	getVenueLabel,
	isMakerLeg,
	RFQ_LEG_TOOLTIP,
	legPairContext,
	getStepContext,
} from './receiptDisplay';

/**
 * The dark hover bubble every tooltip on the receipt shares. `align` picks the edge
 * it anchors to: labels sit in the left column and open leftward, values sit in the
 * right column and open rightward, so neither runs off the card.
 *
 * Rendered as a <span>: two of the call sites live inside a <span>, where the <div>
 * this markup used to duplicate was invalid HTML.
 */
function TooltipBubble({ align, children }: { align: 'left' | 'right'; children: React.ReactNode }) {
	return (
		<span
			role="tooltip"
			className={`pointer-events-none absolute bottom-full ${align === 'left' ? 'left-0' : 'right-0'} z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible`}
		>
			{children}
		</span>
	);
}

// One form only: a solid full-width rule in the theme's primary color. The
// dotted `dashed` variant was retired in the Figma v3 pass — no frame contains
// an internal table rule.
export function Divider({ color }: { color?: string }) {
	return (
		<div
			className="h-px w-full shrink-0 bg-[var(--color-primary)]"
			style={color ? { backgroundColor: `var(--color-${color})` } : undefined}
		/>
	);
}

export function DetailRow({
	label,
	children,
	underscored = false,
	tooltip,
	valueTooltip,
	subValue,
	subValueColor,
	valueColor,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	tooltip?: string;
	valueTooltip?: string;
	/** Second line under the value (e.g. a USD subvalue, or Gained/Lost). */
	subValue?: React.ReactNode;
	/** Overrides the subvalue color; defaults to secondary. */
	subValueColor?: string | undefined;
	/**
	 * Colors the VALUE itself (e.g. green on an Execution Delta gain). Direction belongs on the
	 * number, not on the muted descriptor beneath it — so the subvalue stays secondary
	 * gray and this carries the signal. Losses pass undefined: the app colors gains
	 * green and leaves everything else primary (see formatDialogBps).
	 */
	valueColor?: string | undefined;
}) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			<div>
				{tooltip ? (
					<span className="group relative cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
						{label}
						<TooltipBubble align="left">{tooltip}</TooltipBubble>
					</span>
				) : (
					<span
						className={`text-[var(--color-primary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
					>
						{label}
					</span>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-[10px]">
				{valueTooltip ? (
					<span className="min-w-0 text-right" style={valueColor ? { color: valueColor } : undefined}>
						<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid">
							{children}
							<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
						</span>
					</span>
				) : (
					<span className="min-w-0 text-right" style={valueColor ? { color: valueColor } : undefined}>
						{children}
					</span>
				)}
				{subValue != null && (
					<span
						className="text-[12px] leading-[12px] text-right"
						style={{ color: subValueColor ?? 'var(--color-secondary)' }}
					>
						{subValue}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * Aggregator detail value: the provider name (or the full router address when
 * unattributed), linked to the router contract's Basescan page. The linked
 * address is the contract this trade actually called (`routerAddress` = tx.to,
 * persisted by core) — never a slug→address guess, since one aggregator can
 * run several routers (Odos V2/V3, 0x's per-deploy Settlers). Rows persisted
 * before `routerAddress` existed fall back to the slug when it IS the address
 * (unattributed aggregators); otherwise the name renders unlinked.
 */
export function AggregatorValue({ row }: { row: ReceiptRow }) {
	const slug = row.aggregator.toLowerCase();
	const address = row.routerAddress ?? (slug.startsWith('0x') && slug.length > 10 ? slug : null);
	const label = (
		<span className="break-all" style={{ color: providerColor(slug) }}>
			{formatProvider(slug, { full: true })}
		</span>
	);
	if (!address) return label;
	return (
		<a
			href={`https://basescan.org/address/${address}`}
			target="_blank"
			rel="noreferrer"
			className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
			style={{ textDecorationColor: providerColor(slug) }}
		>
			{label}
		</a>
	);
}

/**
 * Filler detail row: replaces the Aggregator row for UniswapX-anchored
 * trades — there is no aggregator here, only the filler who submitted the
 * fill on the swapper's behalf. Two-line label (Filler / via UniswapX),
 * same grid shell as DetailRow so it lines up with every other row.
 */
export function FillerRow({ address }: { address: string }) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			<div className="flex flex-col gap-[10px]">
				<span className="text-[var(--color-primary)]">Filler</span>
				<span className="text-[var(--color-secondary)]">via UniswapX</span>
			</div>
			<span className="min-w-0 text-right">
				<a
					href={`https://basescan.org/address/${address}`}
					target="_blank"
					rel="noreferrer"
					className="break-all text-[var(--color-primary)] underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
				>
					{address}
				</a>
			</span>
		</div>
	);
}

export function BkdHeading({
	label,
	value,
	color,
	tooltip,
	valueTooltip,
	plain = false,
}: {
	label: string;
	value?: string | undefined;
	color?: string | undefined;
	tooltip?: string | undefined;
	valueTooltip?: string | undefined;
	plain?: boolean;
}) {
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			{tooltip ? (
				<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
					{label}
					<TooltipBubble align="left">{tooltip}</TooltipBubble>
				</span>
			) : (
				<span className={plain ? '' : 'underline decoration-dotted underline-offset-[3px]'}>{label}</span>
			)}
			{value != null && (
				valueTooltip ? (
					<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
						<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
						<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
					</span>
				) : (
					<span className="text-right" style={color ? { color } : undefined}>
						{value}
					</span>
				)
			)}
		</div>
	);
}

export function BkdRow({
	label,
	value,
	context,
	href,
	color,
	labelColor,
	valueTooltip,
	tooltip,
	secondary = false,
	plain = false,
}: {
	label: string;
	value: string;
	/** Trailing muted detail beside the label — the token pair, plus the
	 *  executing router when another aggregator ran this leg. A node, not a
	 *  string, because the router segment is a link and above depth 2 also a
	 *  tooltip trigger. */
	context?: React.ReactNode;
	href?: string | undefined;
	color?: string | undefined;
	labelColor?: string | undefined;
	valueTooltip?: string | undefined;
	tooltip?: string | undefined;
	secondary?: boolean;
	plain?: boolean;
}) {
	const labelClass = [
		plain ? '' : 'underline decoration-dotted underline-offset-[3px]',
		secondary ? 'text-[var(--color-secondary)]' : '',
	]
		.filter(Boolean)
		.join(' ');
	const labelStyle = labelColor ? { color: labelColor } : undefined;
	const labelNode = href ? (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`${labelClass} hover:decoration-solid`}
			style={labelStyle}
		>
			{label}
		</a>
	) : (
		<span className={labelClass} style={labelStyle}>
			{label}
		</span>
	);
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			<div className="min-w-0">
				{tooltip ? (
					<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
						{label}
						<TooltipBubble align="left">{tooltip}</TooltipBubble>
					</span>
				) : (
					labelNode
				)}
				{context != null && (
					<span className="ml-[10px] text-[var(--color-quaternary)]">{context}</span>
				)}
			</div>
			{valueTooltip ? (
				<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
					<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
					<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
				</span>
			) : (
				<span className="text-right" style={color ? { color } : undefined}>
					{value}
				</span>
			)}
		</div>
	);
}

/**
 * The executing-router tag in a leg's context slot: `WETH/cbBTC • Fabric`.
 *
 * Quaternary rather than the provider accent — per-leg accents made the
 * breakdown noisy. The link target is the frame's own contract address, so it
 * resolves to whichever router of that aggregator actually ran (several
 * aggregators run more than one).
 *
 * The full path appears only above depth 2. At depth 2 it is just
 * `topLine › thisRouter`, and the top line is already stated at the head of
 * the receipt, so a tooltip would restate what the reader can see.
 */
function LegRouterTag({ router }: { router: NonNullable<RouteLeg['router']> }) {
	const link = (
		<a
			href={`https://basescan.org/address/${router.address}`}
			target="_blank"
			rel="noreferrer"
			className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
		>
			{formatProvider(router.slug, { full: true })}
		</a>
	);
	if (router.path.length <= 2) return link;
	return (
		<span className="group relative">
			{link}
			<TooltipBubble align="left">
				{router.path.map((slug) => formatProvider(slug, { full: true })).join(' → ')}
			</TooltipBubble>
		</span>
	);
}

/**
 * The muted detail beside a leg's venue label: `WETH/cbBTC • Fabric`.
 *
 * Shared by the two `LegRow` lists and the Price Impact list, which reaches it
 * through receiptView because `getPriceImpactRows` must stay JSX-free —
 * receiptRows already imports from receiptDisplay, so the reverse import would
 * be a cycle.
 *
 * `suppress` is for step rows (wrap/unwrap): their slot holds the step itself,
 * and wrapping is not a routing decision.
 */
export function legContext(
	pair: string | undefined,
	router: RouteLeg['router'],
	suppress: boolean,
): React.ReactNode {
	if (!router || suppress) return pair;
	return (
		<>
			{pair}
			{pair ? ' • ' : ''}
			<LegRouterTag router={router} />
		</>
	);
}

// Shared row for the Cost Breakdown "Liquidity Provider Fee" / "Pools Touched"
// lists — same venue/label/context, differing only in the value column and
// (for the uncosted "Pools Touched" list) an extra guard against legs missing
// a token pair.
export function LegRow({
	leg,
	index,
	legsLength,
	row,
	value,
	color,
	requirePair = false,
}: {
	leg: RouteLeg;
	index: number;
	legsLength: number;
	row: Pick<ReceiptRow, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>;
	value: string;
	color?: string | undefined;
	requirePair?: boolean;
}) {
	const stepContext = getStepContext(leg.type);
	const isStep = stepContext != null;
	const hasPair = leg.tokenIn && leg.tokenOut;
	const hideContext = requirePair && !isStep && !hasPair;
	const maker = isMakerLeg(leg);
	const pair = stepContext ?? (hideContext ? undefined : legPairContext(leg, index, legsLength, row));
	const context = legContext(pair, leg.router, isStep);
	return (
		<BkdRow
			label={getVenueLabel(leg)}
			href={`https://basescan.org/address/${leg.venue}`}
			context={context}
			value={value}
			color={color}
			secondary
			{...(maker ? { labelColor: 'var(--color-secondary)', valueTooltip: RFQ_LEG_TOOLTIP } : {})}
		/>
	);
}
