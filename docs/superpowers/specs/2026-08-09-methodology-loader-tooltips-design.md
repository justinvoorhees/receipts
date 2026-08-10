# Methodology copy, pending-receipt pulse, and touch tooltips

2026-08-09

## Context

Four UI updates against Figma file `f9uYixaSgpkV1lEvN8Ie01`:

1. `/methodology` page content, desktop (`node-id=662-4349`) and mobile (`node-id=667-4628`).
2. A loading treatment for navigating from an already-loaded receipt to another one (`node-id=701-1986`, dev mode).
3. Tooltips triggering on press-and-hold as well as hover, for mobile.

`get_motion_context` returned no keyframe data for node 701-1986, so the transition timing below is user-specified, not read from Figma.

## 1. `/methodology` page content

Current `page.tsx` groups the intro line ("All market prices are measured...") as the first line of the Market Price section, with only two dividers on the page (top, and after Market Price). The new Figma frame restructures this: the disclaimer text moves into the title block as its own section with its own trailing divider, and a new "Per-Leg Price" section is appended after Market Price.

New structure (top to bottom):

- `<Divider />`
- Title section: `h1` "Methodology" + "v0.1", then:
  - "Important: All pricing is provided on a best-effort basis and is not guaranteed. Market prices may be manipulated, skewed, stale, or unavailable. Receipts are provided for informational purposes only and do not constitute financial advice."
  - "All prices are measured at the block immediately before the transaction."
- `<Divider />` (new — doesn't exist today)
- Market Price section:
  - "All market prices are measured..." line is **removed** from here (it moved to the title section above, and the wording changed from "All market prices are measured" to "All prices are measured").
  - WETH/USDC Price paragraph: append "and gas cost." to the existing sentence.
  - Direct-Pool Price / WETH-Derived Price paragraphs: unchanged.
  - Oracle Reference paragraph: **keep the existing "50 bps, or 0.50%" wording**, not Figma's "10 bps, or 0.10%". Confirmed via `packages/core/src/benchmarkPrice.ts`: `MANIPULATION_TOL_BPS = 50` is the oracle-vs-market-mid corroboration check this paragraph describes (matches the receipt page's "Possible manipulation" badge tooltip, "more than 0.5%"). `DIVERGENCE_TOL_BPS = 15` is an unrelated pool-to-pool divergence check, not what this paragraph is about. Figma's "10 bps" doesn't match either constant, so it's a design copy error being intentionally not carried over.
  - Closing sentence gains: "When neither, prices are Unavailable."
- New "Per-Leg Price" section (no divider before it, same 40px rhythm as everything else):
  - Heading: "Per-Leg Price"
  - Body: "The midpoint price from the leg's executing liquidity pool. When unavailable, the deepest qualifying liquidity pool for the same token pair is used as a fallback. Market maker legs remain unpriced by nature."
- `<Divider />` (existing closing divider, now after Per-Leg Price instead of directly after Market Price)

No component structure changes needed beyond `page.tsx` — `Heading`/`Label`/`Body`/`Divider` already exist and cover every element in the new copy.

### Mobile

No dedicated mobile styling work. `Header` and `Footer` are shared layout components (`app/layout.tsx`) already rendered around every page, and both already match the Figma mobile frame exactly:

- `Footer` already stacks its links (`flex-col items-end gap-[20px]` below `md`, `flex-row gap-[40px]` at `md+`), matching node 667-4628's stacked-links footer.
- The page body has no fixed pixel widths; it reflows inside the existing `main` wrapper's `max-w-[720px] mx-auto px-5 md:px-0`.

### Test updates (`app/methodology/page.test.tsx`)

- Update the stale assertion `'All market prices are measured at the block immediately before the transaction.'` → `'All prices are measured at the block immediately before the transaction.'`
- Add assertions for: the "Important:" disclaimer text, "and gas cost.", "When neither, prices are Unavailable.", the new "Per-Leg Price" heading, and that "50 bps, or 0.50%" (not "10 bps") is present.

## 2. Receipt pending-pulse (node 701-1986)

Today, `ReceiptSearch` owns `useTransition()` locally and only uses `isPending` to swap the submit button's label. Because the navigation is wrapped in `startTransition`, Next.js does not show `loading.tsx` for this client-side transition — the previously-rendered receipt just sits there unchanged with no visual feedback beyond the button.

Change: lift the pending state to `ReceiptView` (the common parent of `ReceiptSearch` and `Receipt`), and use it to pulse the still-mounted receipt while the next one loads.

- `ReceiptView` calls `useTransition()` and passes `isPending` and `startTransition` down to `ReceiptSearch` as props.
- `ReceiptSearch` keeps its own local UI state (input value, hover/focus, paste handling, local failure) untouched, but wraps its `router.push(...)` call in the **passed-down** `startTransition` instead of creating its own.
- `ReceiptView` wraps `<Receipt row={trade} />` in a container that gets a `receipt-pending-pulse` class whenever `isPending` is true.
- New CSS in `styles/globals.css`, following the existing `row-fade-in`/`tx-row-enter` convention:

  ```css
  @keyframes receipt-pulse {
  	0%,
  	100% {
  		opacity: 1;
  	}
  	50% {
  		opacity: 0.5;
  	}
  }
  .receipt-pending-pulse {
  	animation: receipt-pulse 800ms linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
  	.receipt-pending-pulse {
  		animation: none;
  		opacity: 0.5;
  	}
  }
  ```

  This is linear 100%→50% over 400ms, then 50%→100% over 400ms, looping every 800ms, exactly as specified. Under `prefers-reduced-motion: reduce`, it renders as a static 50% opacity instead of animating.

- Because React only swaps the old subtree for the new one once the new route's data is ready, the pulse naturally keeps looping "until the next receipt loads" with no extra wiring — `isPending` flips to `false` at exactly the moment the new `trade` prop replaces the old one.
- The empty-search-box case (no `trade` yet, e.g. the homepage) needs no pulse — there's nothing to dim, matching current behavior of `loading.tsx`'s "Analyzing transaction…" for a first-time analysis.

## 3. Touch tooltips

All six tooltip trigger sites in `components/receipt/receiptRows.tsx` (`DetailRow`'s label and value tooltips, `BkdHeading`'s label and value tooltips, `BkdRow`'s label and value tooltips, and `LegRouterTag`'s link tooltip) share the same shape: a `<span className="group relative ...">` wrapping the trigger content plus a `TooltipBubble` that shows on `group-hover`.

Extract this into one shared component so touch support is written once:

```tsx
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

function TooltipTrigger({
	tooltip,
	align,
	className,
	children,
}: {
	tooltip: React.ReactNode;
	align: 'left' | 'right';
	className: string;
	children: React.ReactNode;
}) {
	const { ref, touched, onTouchStart } = useTouchTooltip<HTMLSpanElement>();
	return (
		<span ref={ref} onTouchStart={onTouchStart} className={`group relative ${className}`}>
			{children}
			<TooltipBubble align={align} forceVisible={touched}>
				{tooltip}
			</TooltipBubble>
		</span>
	);
}
```

- `TooltipBubble` gains an optional `forceVisible` prop; when true it renders `visible` instead of `invisible group-hover:visible`.
- Touch shows the tooltip instantly on `touchstart` (no delay/long-press timer — confirmed this is what "instant" means here).
- A `touchstart` anywhere outside the trigger's own element dismisses it.
- Hover is untouched — same CSS `group-hover` mechanism as today.
- `LegRouterTag` (the one site where the trigger is a link, not plain text) gets the same treatment: touch shows its tooltip, and a tap still follows the link, same as every other trigger. (Per your answer that no link+tooltip combination should get special two-tap handling.)
- Each of the six call sites in `receiptRows.tsx` is rewritten to use `<TooltipTrigger>` in place of its current inline `<span className="group ..."><TooltipBubble/></span>` pair, passing through the exact same className strings that exist today — so the rendered DOM structure and classes are unchanged for sites where `touched` is false, keeping existing `renderToStaticMarkup`-based tests (which check for `role="tooltip"` and specific copy) green.

### Verification

This package has no interaction-testing library (no `@testing-library`, no Playwright) — every existing test renders with `renderToStaticMarkup` and asserts on the resulting HTML string. Static assertions can confirm markup/copy is correct, but `touchstart`/dismiss behavior and the pulse animation are runtime-only and will be verified manually against the dev server in a browser (dev tools touch emulation for the tooltip case), not by an automated test.

## Out of scope

- No changes to `packages/core` pricing logic or constants.
- No changes to the QA multi-hash comparison page (`app/qa/tx/[chain]/[hashes]`) — unrelated to the pending-pulse feature, confirmed during design discussion.
- No two-tap link-confirmation gating for tooltip-carrying links.
