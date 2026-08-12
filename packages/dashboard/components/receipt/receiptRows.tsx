'use client';
/**
 * receiptRows — the presentational row/layout sub-components of the receipt
 * (DetailRow, the Cost-Breakdown rows, dividers, aggregator/filler rows). Split out
 * of ReceiptView.tsx (2026-07-21). Presentational except for `TooltipTrigger`, which
 * holds the touch-tooltip state (`useTouchTooltip`). Marked 'use client' to match the
 * receipt/ leaf convention.
 */
import { useEffect, useRef, useState } from 'react';
import { providerColor, formatProvider } from '../../lib/formatters';
import type { ReceiptModel } from '../../lib/receiptModel';
import type { RouteLeg } from '../../lib/legRouterEnrichment';
import { DEFAULT_CHAIN, explorerAddress } from '../../lib/chains';
import {
	getVenueLabel,
	isMakerLeg,
	legLinkAddress,
	RFQ_LEG_TOOLTIP,
	legPairContext,
	getStepContext,
} from './receiptDisplay';
import { MARKET_PRICE_BLOCK_LABELS } from './priceDispersion';

/**
 * The dark hover bubble every tooltip on the receipt shares. `align` picks the edge
 * it anchors to: labels sit in the left column and open leftward, values sit in the
 * right column and open rightward, so neither runs off the card.
 *
 * Rendered as a <span>: two of the call sites live inside a <span>, where the <div>
 * this markup used to duplicate was invalid HTML.
 */
function TooltipBubble({
	align,
	forceVisible = false,
	bubbleClassName,
	children,
}: {
	align: 'left' | 'right';
	/** Forces the bubble visible outside of CSS :hover — set by a touch on the trigger. */
	forceVisible?: boolean;
	/** Appended to the bubble's class string — for call sites that need extra
	 *  styling on top of the shared dark-bubble treatment (e.g. FailureNotice's
	 *  monospace font + no-underline). */
	bubbleClassName?: string | undefined;
	children: React.ReactNode;
}) {
	return (
		<span
			role="tooltip"
			className={`pointer-events-none absolute bottom-full ${align === 'left' ? 'left-0' : 'right-0'} z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] ${forceVisible ? 'visible' : 'invisible group-hover:visible'} ${bubbleClassName ?? ''}`.trim()}
		>
			{children}
		</span>
	);
}

/**
 * Mirrors CSS :hover for touch devices: a touchstart on the trigger shows the
 * tooltip instantly, and a touchstart anywhere else dismisses it. Each call gets its
 * own instance, so touching one tooltip never affects another.
 */
function useTouchTooltip<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		if (!touched) return;
		const dismiss = (e: TouchEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setTouched(false);
		};
		document.addEventListener('touchstart', dismiss);
		return () => document.removeEventListener('touchstart', dismiss);
	}, [touched]);
	return { ref, touched, onTouchStart: () => setTouched(true) };
}

/**
 * The shared trigger+bubble pair every tooltip on the receipt uses: hover shows it
 * (CSS group-hover, untouched), and on touch devices a touchstart shows it instantly
 * too. `className`/`style` carry the trigger's own visual styling exactly as each call
 * site rendered it inline before this was extracted.
 */
export function TooltipTrigger({
	tooltip,
	align,
	className,
	style,
	bubbleClassName,
	children,
}: {
	tooltip: React.ReactNode;
	align: 'left' | 'right';
	className: string;
	style?: React.CSSProperties | undefined;
	bubbleClassName?: string | undefined;
	children: React.ReactNode;
}) {
	const { ref, touched, onTouchStart } = useTouchTooltip<HTMLSpanElement>();
	return (
		<span
			ref={ref}
			onTouchStart={onTouchStart}
			className={`group relative ${className}`.trim()}
			style={style}
		>
			{children}
			<TooltipBubble align={align} forceVisible={touched} bubbleClassName={bubbleClassName}>
				{tooltip}
			</TooltipBubble>
		</span>
	);
}

// One form only: a solid full-width rule in the theme's primary color. The
// dotted `dashed` variant was retired in the Figma v3 pass — no frame contains
// an internal table rule.
export function Divider() {
	return <div className="h-px w-full shrink-0 bg-[var(--color-primary)]" />;
}

const METHODOLOGY_TERMS = [
	'direct-pool price',
	'WETH-derived price',
	'oracle reference',
	'three WETH/USDC pool prices',
] as const;
const METHODOLOGY_PATTERN = new RegExp(`(${METHODOLOGY_TERMS.join('|')})`, 'g');

/**
 * Renders a Market Price methodology sentence (packages/core/src/pricing.ts
 * `methodologyFor`) with its fixed phrases turned into dotted-underline
 * links to /methodology, opening in a new tab (Figma 546-694). The fourth term
 * covers the USDC/WETH fast-path sentence only (pricing.ts:465-466), which
 * names its liquidity source differently from the general-path sentences.
 * The phrase list is exhaustive — every sentence `methodologyFor` can produce
 * is built only from these literal strings plus fixed prose — so a single
 * non-overlapping split is sufficient; no priority/longest-match logic needed.
 */
/**
 * The phrase the depth-floor methodology sentence uses for its reference pool.
 * Linking it is the ONLY way the pool behind a refused market price is reachable
 * — there is no depth row on the receipt — which is why `referencePoolAddress`
 * is persisted rather than just the depth number.
 */
const POOL_PHRASE = 'deepest reference pool';

export function MethodologyText({
	text,
	poolAddress,
}: {
	text: string;
	/** The reference pool this sentence is about, when one was recorded. */
	poolAddress?: string | null;
}) {
	// Only linked when we know WHICH pool. A sentence naming a pool we cannot
	// point at stays plain text rather than becoming a dead link.
	if (poolAddress && text.includes(POOL_PHRASE)) {
		const [before, ...rest] = text.split(POOL_PHRASE);
		return (
			<>
				{before}
				<a
					href={explorerAddress(DEFAULT_CHAIN, poolAddress)}
					target="_blank"
					rel="noreferrer"
					className="underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
				>
					{POOL_PHRASE}
				</a>
				{rest.join(POOL_PHRASE)}
			</>
		);
	}

	return (
		<>
			{text.split(METHODOLOGY_PATTERN).map((part, i) =>
				(METHODOLOGY_TERMS as readonly string[]).includes(part) ? (
					<a
						key={i}
						href="/methodology"
						target="_blank"
						rel="noreferrer"
						className="underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
					>
						{part}
					</a>
				) : (
					part
				),
			)}
		</>
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
	hug = false,
	stackOnMobile = false,
	labelSubValue,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	tooltip?: string;
	valueTooltip?: string | undefined;
	/** Second line under the value (e.g. a USD subvalue). */
	subValue?: React.ReactNode;
	/** Overrides the subvalue color; defaults to secondary. */
	subValueColor?: string | undefined;
	/**
	 * Second line under the LABEL, 10px below it (matching FillerRow's
	 * "Filler" / "via UniswapX" two-line label) — for a disclosure that
	 * qualifies the row's label rather than its value, e.g. the Aggregator
	 * row's beneficiary-anchor note ("Executed via UniswapX" / "Executed via
	 * Solver").
	 */
	labelSubValue?: React.ReactNode;
	/**
	 * Opts this row out of the 34px floor so it hugs its content. Only the Market
	 * Price row uses it: its methodology footnote sits 10px below the row inside a
	 * shared wrapper, so a floor here would push the footnote off its mark
	 * (Figma 546-687 = 34+10+36; 549-3112 = 12+10+36 when there is no subvalue).
	 * The opposite polarity of `standalone` on BkdHeading/BkdRow below, which opts
	 * IN to the same floor — `hug` starts floored and opts out, `standalone` starts
	 * unfloored and opts in.
	 */
	hug?: boolean;
	/**
	 * Stacks the value under the label below `md`, with a 15px gap (Figma
	 * 667-4681 / 666-4616). Only Execution Delta and Price Delta use this —
	 * every other DetailRow (Aggregator, Pair, Chain, Block, Token In/Out, Gas
	 * Cost, Execution Price) keeps the label and value on one line at every
	 * width (Figma 666-4468).
	 */
	stackOnMobile?: boolean;
}) {
	return (
		<div
			className={
				stackOnMobile
					? `flex flex-col gap-[15px] md:grid md:grid-cols-[180px_1fr] md:gap-x-[10px] md:gap-y-0 ${hug ? '' : 'min-h-[34px]'}`
					: `flex items-start justify-between gap-x-[10px] md:grid md:grid-cols-[180px_1fr] ${hug ? '' : 'min-h-[34px]'}`
			}
		>
			<div className={`shrink-0 ${labelSubValue != null ? 'flex flex-col gap-[10px]' : ''}`}>
				{tooltip ? (
					<TooltipTrigger
						tooltip={tooltip}
						align="left"
						className="cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
					>
						{label}
					</TooltipTrigger>
				) : (
					<span
						className={`text-[var(--color-primary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
					>
						{label}
					</span>
				)}
				{labelSubValue != null && (
					<span className="text-[var(--color-secondary)]">{labelSubValue}</span>
				)}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-[10px]">
				{valueTooltip ? (
					<span className="min-w-0 text-right">
						<TooltipTrigger
							tooltip={valueTooltip}
							align="right"
							className="cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
						>
							{children}
						</TooltipTrigger>
					</span>
				) : (
					<span className="min-w-0 text-right">{children}</span>
				)}
				{subValue != null && (
					<span
						className="whitespace-nowrap text-[12px] leading-[12px] text-right"
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
 * (unattributed aggregators); otherwise the name renders unlinked. Also covers
 * unattributed solvers: a beneficiary-anchored, non-UniswapX trade renders its
 * solver address through this same row (the UniswapX filler has its own row,
 * FillerRow, below).
 *
 * The Aggregator row stays on one line at every width (not `stackOnMobile`),
 * so an unattributed 42-char address has no room to wrap cleanly there — it
 * shows `shortTxHash`'s truncated form below `md`, where desktop has the
 * width to show it in full.
 */
export function AggregatorValue({ row }: { row: ReceiptModel }) {
	const slug = row.aggregator.toLowerCase();
	const address = row.routerAddress ?? (slug.startsWith('0x') && slug.length > 10 ? slug : null);
	const full = formatProvider(slug, { full: true });
	const short = formatProvider(slug);
	const label = (
		<span style={{ color: providerColor(slug) }}>
			{full === short ? (
				full
			) : (
				<>
					<span className="md:hidden">{short}</span>
					<span className="hidden break-all md:inline">{full}</span>
				</>
			)}
		</span>
	);
	if (!address) return label;
	return (
		<a
			href={explorerAddress(DEFAULT_CHAIN, address)}
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
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px] min-h-[34px]">
			<div className="flex flex-col gap-[10px]">
				<span className="text-[var(--color-primary)]">Filler</span>
				<span className="text-[var(--color-secondary)]">via UniswapX</span>
			</div>
			<span className="min-w-0 text-right">
				<a
					href={explorerAddress(DEFAULT_CHAIN, address)}
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
	standalone = false,
}: {
	label: string;
	value?: string | undefined;
	color?: string | undefined;
	tooltip?: string | undefined;
	valueTooltip?: string | undefined;
	plain?: boolean;
	/**
	 * A row that is not part of a heading+children group takes the 34px floor.
	 * Group members (fee sinks, legs, and the headings that own them) stay at
	 * 12px on the container's 20px gap — Figma 546-713.
	 * The opposite polarity of `hug` on DetailRow above, which opts OUT of the
	 * same floor — `standalone` starts unfloored and opts in, `hug` starts
	 * floored and opts out.
	 */
	standalone?: boolean;
}) {
	return (
		<div className={`grid grid-cols-[1fr_92px] gap-x-[24px] ${standalone ? 'min-h-[34px]' : ''}`}>
			{tooltip ? (
				<TooltipTrigger
					tooltip={tooltip}
					align="left"
					className="cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
				>
					{label}
				</TooltipTrigger>
			) : (
				<span className={plain ? '' : 'underline decoration-dotted underline-offset-[3px]'}>{label}</span>
			)}
			{value != null && (
				valueTooltip ? (
					<TooltipTrigger
						tooltip={valueTooltip}
						align="right"
						className="text-right cursor-default"
						style={color ? { color } : undefined}
					>
						<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
					</TooltipTrigger>
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
	standalone = false,
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
	/**
	 * A row that is not part of a heading+children group takes the 34px floor.
	 * Group members (fee sinks, legs, and the headings that own them) stay at
	 * 12px on the container's 20px gap — Figma 546-713.
	 * The opposite polarity of `hug` on DetailRow above, which opts OUT of the
	 * same floor — `standalone` starts unfloored and opts in, `hug` starts
	 * floored and opts out.
	 */
	standalone?: boolean;
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
		<div className={`grid grid-cols-[1fr_92px] gap-x-[24px] ${standalone ? 'min-h-[34px]' : ''}`}>
			<div className="min-w-0 flex flex-col gap-[10px] md:block">
				{tooltip ? (
					<TooltipTrigger
						tooltip={tooltip}
						align="left"
						className="cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
					>
						{label}
					</TooltipTrigger>
				) : (
					labelNode
				)}
				{context != null && (
					<span className="text-[var(--color-quaternary)] md:ml-[10px]">{context}</span>
				)}
			</div>
			{valueTooltip ? (
				<TooltipTrigger
					tooltip={valueTooltip}
					align="right"
					className="text-right cursor-default"
					style={color ? { color } : undefined}
				>
					<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
				</TooltipTrigger>
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
			href={explorerAddress(DEFAULT_CHAIN, router.address)}
			target="_blank"
			rel="noreferrer"
			className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
		>
			{formatProvider(router.slug, { full: true })}
		</a>
	);
	if (router.path.length <= 2) return link;
	return (
		<TooltipTrigger tooltip={router.path.map((slug) => formatProvider(slug, { full: true })).join(' → ')} align="left" className="">
			{link}
		</TooltipTrigger>
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
	valueTooltip,
}: {
	leg: RouteLeg;
	index: number;
	legsLength: number;
	row: Pick<ReceiptModel, 'inputToken' | 'outputToken' | 'inputSymbol' | 'outputSymbol'>;
	value: string;
	color?: string | undefined;
	requirePair?: boolean;
	/** Explains a non-numeric cell (e.g. an unresolved fee tier). */
	valueTooltip?: string | undefined;
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
			href={explorerAddress(DEFAULT_CHAIN, legLinkAddress(leg))}
			context={context}
			value={value}
			color={color}
			secondary
			{...(maker
				? { labelColor: 'var(--color-secondary)', valueTooltip: RFQ_LEG_TOOLTIP }
				: valueTooltip
					? { valueTooltip }
					: {})}
		/>
	);
}

/**
 * Market Price rendered as three adjacent-block samples (Figma 647-3599).
 *
 * `At Block` is the ruler (N-1) and is the only row in primary — the two
 * neighbours are context. All three come from the SAME pool; see the design
 * spec for why re-discovering per block would be wrong.
 */
export function MarketPriceTable({
	before,
	at,
	after,
}: {
	before: React.ReactNode;
	at: React.ReactNode;
	after: React.ReactNode;
}) {
	const SEC = 'var(--color-secondary)';
	const PRI = 'var(--color-primary)';
	const [beforeLabel, atLabel, afterLabel] = MARKET_PRICE_BLOCK_LABELS;
	const rows: [string, React.ReactNode, string][] = [
		[beforeLabel, before, SEC],
		[atLabel, at, PRI],
		[afterLabel, after, SEC],
	];
	return (
		<div className="flex flex-col gap-[15px] md:flex-row md:items-start md:justify-between md:gap-0 text-[12px] leading-[12px]">
			<p style={{ color: PRI, fontFeatureSettings: '"calt" 0' }} className="whitespace-nowrap">
				Market Price
			</p>
			<div className="flex flex-col gap-[10px]">
				{rows.map(([label, value, color]) => (
					<div key={label} className="flex items-center justify-between gap-[20px]">
						<p className="w-[87px] whitespace-nowrap" style={{ color, fontFeatureSettings: '"calt" 0' }}>{label}</p>
						{/* min-w, NOT a fixed w: Figma 647-3599 sizes this column to its own
						    example string ("35.0269 ETH = 1 WBTC" is exactly 20 chars ≈ 144px),
						    so a hard width wraps every longer real value — cbBTC/USDC needs
						    ~180px. The 144px stays as the floor so the three rows keep the
						    designed column edge; nowrap is what actually guarantees one line. */}
						<p className="min-w-[144px] whitespace-nowrap text-right" style={{ color, fontFeatureSettings: '"calt" 0' }}>{value}</p>
					</div>
				))}
			</div>
		</div>
	);
}
