# Methodology Copy, Pending-Receipt Pulse, and Touch Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `/methodology` to match the new Figma copy/typography, add an opacity-pulse loading treatment to the still-mounted receipt while a second (or later) transaction is being analyzed, add press-and-hold tooltip support for touch devices, and open every footer link in a new tab.

**Architecture:** Four independent, sequential changes in `packages/dashboard`: (1) a content/typography rewrite of `app/methodology/page.tsx`, (2) lifting `useTransition` from `ReceiptSearch` up to its parent `ReceiptView` so the still-visible `Receipt` can be dimmed via a CSS class while a navigation is pending, (3) extracting the six duplicated tooltip-trigger call sites in `receiptRows.tsx` into one `TooltipTrigger` component that adds touch support on top of the existing CSS-hover mechanism, and (4) a two-line change to `Footer`'s link rendering.

**Tech Stack:** Next.js 15 (App Router) + React 19, Tailwind CSS v4 (arbitrary bracket values, no custom config), Vitest with `renderToStaticMarkup` (no `@testing-library`, no Playwright — see Global Constraints).

## Global Constraints

- Design source: Figma file `f9uYixaSgpkV1lEvN8Ie01` — desktop methodology `node-id=662-4349`, mobile methodology `node-id=667-4628`, pending-state reference `node-id=701-1986`.
- The Oracle Reference paragraph keeps "50 bps, or 0.50%" — this matches `MANIPULATION_TOL_BPS = 50` in `packages/core/src/benchmarkPrice.ts`. Do **not** use Figma's "10 bps" figure; do not touch `packages/core`.
- Pending-pulse animation: linear, opacity 100%→50% over 400ms then 50%→100% over 400ms, looping every 800ms while pending. Under `prefers-reduced-motion: reduce`, render a static 50% opacity instead of animating.
- Touch tooltips show instantly on `touchstart` (no delay/long-press timer) and dismiss on a `touchstart` outside the trigger. No two-tap gating for tooltip-carrying links (confirmed: apply uniformly, including `LegRouterTag`).
- This package (`packages/dashboard`) has no interaction-testing library — every existing test renders with `renderToStaticMarkup` from `react-dom/server` and asserts on the resulting HTML string. Do not invent `fireEvent`/`userEvent`-style tests; they will not run. Where a behavior is only observable at runtime (touch dismiss, the pulse animation), verify manually against the dev server instead of writing a fake test for it.
- **Run tests from the repo root**, not from `packages/dashboard` — `npx vitest run` from inside the package reports roughly half the real suite.
- Do not modify `app/qa/tx/[chain]/[hashes]` — out of scope, confirmed during design.

---

## File Structure

- Modify `packages/dashboard/components/footer.tsx` + `footer.test.tsx` — footer links open in a new tab.
- Modify `packages/dashboard/app/methodology/page.tsx` + `page.test.tsx` — content, structure, and typography.
- Modify `packages/dashboard/components/receipt/receiptRows.tsx` + `packages/dashboard/components/receiptView.test.tsx` — shared `TooltipTrigger` component, touch support.
- Modify `packages/dashboard/components/receiptSearch.tsx`, `packages/dashboard/components/receiptView.tsx`, `packages/dashboard/styles/globals.css` + `receiptView.test.tsx` — pending-pulse.

---

### Task 1: Footer links open in a new tab

**Files:**
- Modify: `packages/dashboard/components/footer.tsx`
- Test: `packages/dashboard/components/footer.test.tsx`

**Interfaces:** None — `Footer` takes no props today and none are added.

- [ ] **Step 1: Write the failing test**

Add to `packages/dashboard/components/footer.test.tsx`, inside the existing `describe('Footer', ...)` block:

```tsx
	it('opens every footer link in a new tab', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		const targets = html.match(/target="_blank"/g) ?? [];
		expect(targets.length).toBe(4);
		const rels = html.match(/rel="noreferrer"/g) ?? [];
		expect(rels.length).toBe(4);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root: `npx vitest run packages/dashboard/components/footer.test.tsx -t "opens every footer link"`
Expected: FAIL — 0 matches for `target="_blank"`.

- [ ] **Step 3: Add `target`/`rel` to the footer link anchors**

In `packages/dashboard/components/footer.tsx`, change the link render (currently the `<a>` inside `LINKS.map`):

```tsx
					<a
						key={link.href}
						href={link.href}
						target="_blank"
						rel="noreferrer"
						className="text-[var(--color-secondary)] underline underline-offset-[3px] [text-decoration-skip-ink:none] hover:text-[var(--color-primary)]"
					>
						{link.label}
					</a>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/components/footer.test.tsx`
Expected: PASS, all tests in the file green (including the 3 pre-existing ones — confirms no regression).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/footer.tsx packages/dashboard/components/footer.test.tsx
git commit -m "feat(dashboard): open footer links in a new tab"
```

---

### Task 2: `/methodology` content, structure, and typography

**Files:**
- Modify: `packages/dashboard/app/methodology/page.tsx`
- Test: `packages/dashboard/app/methodology/page.test.tsx`

**Interfaces:** None — this is a leaf page with no props, consumed by nothing else in this codebase besides the App Router itself and `Footer`'s `/methodology` link (untouched).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `packages/dashboard/app/methodology/page.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('Methodology page', () => {
	it('renders the title, version, and every method heading in order', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('>Methodology<');
		expect(html).toContain('v0.1');
		expect(html).toContain('>Market Price<');
		expect(html).toContain('>Per-Leg Price<');
		for (const label of ['WETH/USDC Price:', 'Direct-Pool Price:', 'WETH-Derived Price:', 'Oracle Reference:']) {
			expect(html).toContain(label);
		}
		expect(html.indexOf('WETH/USDC Price:')).toBeLessThan(html.indexOf('Direct-Pool Price:'));
		expect(html.indexOf('Direct-Pool Price:')).toBeLessThan(html.indexOf('WETH-Derived Price:'));
		expect(html.indexOf('WETH-Derived Price:')).toBeLessThan(html.indexOf('Oracle Reference:'));
		expect(html.indexOf('>Market Price<')).toBeLessThan(html.indexOf('>Per-Leg Price<'));
	});

	it('renders labels uppercase (CSS transform) at 12px/12px, matching Figma 662-4349', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		// The text node itself stays mixed-case; `uppercase` is a CSS transform, not a
		// text change, so the raw markup still reads "WETH/USDC Price:".
		expect(html).toContain('WETH/USDC Price:');
		expect(html).toContain('text-[12px] leading-[12px] font-medium uppercase');
	});

	it('renders body paragraphs at 12px/20px, matching Figma (was 14px)', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('text-[12px] leading-[20px]');
		expect(html).not.toContain('text-[14px]');
	});

	it('groups the title and version tag on a 12px gap, separate from the page-wide 20px rhythm', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('gap-[12px]');
	});

	it('states the disclaimer and the measurement rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(
			'Important: All pricing is provided on a best-effort basis and is not guaranteed.',
		);
		expect(html).toContain('All prices are measured at the block immediately before the transaction.');
		// The old Market-Price-scoped wording is gone — the sentence moved to the title
		// section and dropped "market" from its phrasing.
		expect(html).not.toContain('All market prices are measured');
	});

	it('mentions gas cost in the WETH/USDC Price paragraph', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('other token pairs and gas cost.');
	});

	it('states the Verified/Estimated/Unavailable rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('When at least 2/3 methods agree, prices are Verified.');
		expect(html).toContain('When neither, prices are Unavailable.');
	});

	it('keeps the oracle tolerance at 50bps, matching MANIPULATION_TOL_BPS', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('50 bps, or 0.50%');
		expect(html).not.toContain('10 bps');
	});

	it('states the Per-Leg Price fallback rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(
			"The midpoint price from the leg’s executing liquidity pool. When unavailable, the deepest qualifying liquidity pool for the same token pair is used as a fallback. Market maker legs remain unpriced by nature.",
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root: `npx vitest run packages/dashboard/app/methodology/page.test.tsx`
Expected: FAIL — the disclaimer, "Per-Leg Price", "gas cost", "Unavailable", 12px classes, and `gap-[12px]` assertions all fail against the current page; the "not.toContain('All market prices are measured')" and "not.toContain('text-[14px]')" assertions also fail (those strings are currently present).

- [ ] **Step 3: Rewrite `page.tsx`**

Replace the full contents of `packages/dashboard/app/methodology/page.tsx`:

```tsx
import { Divider } from '../../components/receipt/receiptRows';

export const metadata = {
	title: 'Methodology - Receipts',
};

// Transcribed verbatim from Figma 662-4349 (desktop) / 667-4628 (mobile), except the
// Oracle Reference tolerance figure — kept at 50bps to match the real
// MANIPULATION_TOL_BPS constant in packages/core/src/benchmarkPrice.ts rather than
// Figma's "10 bps", which doesn't match any real constant. Prose only — no data
// access. Every block in a section is 20px apart; the page's outer rhythm is 40px.
function Heading({ children }: { children: React.ReactNode }) {
	return (
		<h2
			className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{children}
		</h2>
	);
}

function Label({ children }: { children: React.ReactNode }) {
	return <p className="text-[12px] leading-[12px] font-medium uppercase">{children}</p>;
}

function Body({ children }: { children: React.ReactNode }) {
	return <p className="text-[12px] leading-[20px]">{children}</p>;
}

export default function MethodologyPage() {
	return (
		<div className="mt-[40px] flex flex-col gap-[40px] font-['Sohne']">
			<Divider />

			<div className="flex flex-col gap-[20px]">
				<div className="flex flex-col gap-[12px]">
					<h1
						className="font-['Sohne_Breit'] font-medium text-[28px] leading-[28px]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						Methodology
					</h1>
					<p className="text-[12px] leading-[12px] text-[var(--color-secondary)]">v0.1</p>
				</div>
				<Body>
					Important: All pricing is provided on a best-effort basis and is not guaranteed. Market
					prices may be manipulated, skewed, stale, or unavailable. Receipts are provided for
					informational purposes only and do not constitute financial advice.
				</Body>
				<Body>All prices are measured at the block immediately before the transaction.</Body>
			</div>

			<Divider />

			<div className="flex flex-col gap-[20px]">
				<Heading>Market Price</Heading>

				<Label>WETH/USDC Price:</Label>
				<Body>
					The median price from three designated WETH/USDC liquidity pools, cross-referenced against
					an oracle reference. Used directly for WETH/USDC transactions or as a reference when pricing
					other token pairs and gas cost.
				</Body>

				<Body>All other prices may use up to three methods:</Body>

				<Label>Direct-Pool Price:</Label>
				<Body>
					The midpoint price from the deepest qualifying liquidity pool that trades the input and
					output tokens directly.
				</Body>

				<Label>WETH-Derived Price:</Label>
				<Body>
					The implied price linking the input and output tokens together through WETH. It is
					calculated from the midpoint price of the deepest qualifying token/WETH pool for each
					applicable token, cross-referenced against the WETH/USDC price method. For example,
					AAA/WETH and WETH/BBB can be combined to derive an AAA/BBB price. Used to corroborate a
					direct-pool price, or provide a fallback when no direct-pool price is available.
				</Body>

				<Label>Oracle Reference:</Label>
				<Body>
					An independent reference price calculated from external price feeds (Chainlink) for the
					input and output tokens. Used to corroborate liquidity-based prices within a tolerance of
					50 bps, or 0.50%. Oracle reference is never used to calculate Market Price.
				</Body>

				<Body>
					When at least 2/3 methods agree, prices are Verified. When only the direct-pool method or
					WETH-derived method are available, prices are Estimated. When neither, prices are
					Unavailable.
				</Body>
			</div>

			<div className="flex flex-col gap-[20px]">
				<Heading>Per-Leg Price</Heading>
				<Body>
					The midpoint price from the leg’s executing liquidity pool. When unavailable, the deepest
					qualifying liquidity pool for the same token pair is used as a fallback. Market maker legs
					remain unpriced by nature.
				</Body>
			</div>

			<Divider />
		</div>
	);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/dashboard/app/methodology/page.test.tsx`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Run the full dashboard test suite for regressions**

Run from repo root: `npx vitest run packages/dashboard`
Expected: PASS — no other file imports `app/methodology/page.tsx`, so this should be an isolated change, but confirm.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/methodology/page.tsx packages/dashboard/app/methodology/page.test.tsx
git commit -m "feat(dashboard): update /methodology copy, structure, and typography to Figma 662-4349"
```

---

### Task 3: Touch tooltip support (`TooltipTrigger`)

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Produces (used only within `receiptRows.tsx`, not exported): `TooltipTrigger({ tooltip: React.ReactNode; align: 'left' | 'right'; className: string; style?: React.CSSProperties; children: React.ReactNode })`, and `TooltipBubble`'s new optional `forceVisible?: boolean` prop (default `false`).
- Consumes: nothing new — replaces inline JSX at 6 existing call sites in the same file.

This task has one meaningful automated check (that the default, untouched state renders identically to today — pure regression), plus a full-suite regression run, because `touchstart`/dismiss behavior is runtime-only and this package has no interaction-testing library (see Global Constraints). Manual verification is Step 6.

- [ ] **Step 1: Write the failing regression test**

Add to `packages/dashboard/components/receiptView.test.tsx` (anywhere at the top level, e.g. right after the `fallbackMethodology` describe block):

```tsx
describe('tooltip touch support', () => {
	it('keeps a tooltip hover-only until touched — default render is unchanged', async () => {
		const { DetailRow } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<DetailRow label="Gas Cost" tooltip="Paid separately in ETH">
				$0.01
			</DetailRow>,
		);
		expect(html).toContain('role="tooltip"');
		expect(html).toContain('invisible group-hover:visible');
		expect(html).not.toContain('"visible"');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t "keeps a tooltip hover-only"`
Expected: PASS actually — this specific assertion matches today's behavior already. Run it now only to confirm `DetailRow`'s `tooltip` prop path renders as expected *before* the refactor, so Step 5 proves the refactor didn't change it. (There is no way to write a test that fails before this task's implementation and passes after, since the feature under test — touch events — cannot be simulated by `renderToStaticMarkup`. This step exists to pin the pre-refactor baseline, not to red/green the new behavior.)

- [ ] **Step 3: Add the `react` hooks import**

In `packages/dashboard/components/receipt/receiptRows.tsx`, add this import near the top (after the `'use client';` directive and file doc-comment, before the `../../lib/formatters` import):

```tsx
import { useEffect, useRef, useState } from 'react';
```

- [ ] **Step 4: Add `useTouchTooltip`, `TooltipTrigger`, and the `forceVisible` prop on `TooltipBubble`**

Replace the existing `TooltipBubble` function (currently lines 30-39) with:

```tsx
function TooltipBubble({
	align,
	forceVisible = false,
	children,
}: {
	align: 'left' | 'right';
	/** Forces the bubble visible outside of CSS :hover — set by a touch long-press. */
	forceVisible?: boolean;
	children: React.ReactNode;
}) {
	return (
		<span
			role="tooltip"
			className={`pointer-events-none absolute bottom-full ${align === 'left' ? 'left-0' : 'right-0'} z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] ${forceVisible ? 'visible' : 'invisible group-hover:visible'}`}
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
function TooltipTrigger({
	tooltip,
	align,
	className,
	style,
	children,
}: {
	tooltip: React.ReactNode;
	align: 'left' | 'right';
	className: string;
	style?: React.CSSProperties;
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
			<TooltipBubble align={align} forceVisible={touched}>
				{tooltip}
			</TooltipBubble>
		</span>
	);
}
```

- [ ] **Step 5: Replace the 6 inline call sites with `TooltipTrigger`**

In `DetailRow` (label tooltip), replace:

```tsx
				{tooltip ? (
					<span className="group relative cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
						{label}
						<TooltipBubble align="left">{tooltip}</TooltipBubble>
					</span>
				) : (
```

with:

```tsx
				{tooltip ? (
					<TooltipTrigger
						tooltip={tooltip}
						align="left"
						className="cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
					>
						{label}
					</TooltipTrigger>
				) : (
```

In `DetailRow` (value tooltip), replace:

```tsx
				{valueTooltip ? (
					<span className="min-w-0 text-right">
						<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid">
							{children}
							<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
						</span>
					</span>
				) : (
```

with:

```tsx
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
```

In `BkdHeading` (label tooltip), replace:

```tsx
			{tooltip ? (
				<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
					{label}
					<TooltipBubble align="left">{tooltip}</TooltipBubble>
				</span>
			) : (
```

with:

```tsx
			{tooltip ? (
				<TooltipTrigger
					tooltip={tooltip}
					align="left"
					className="cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
				>
					{label}
				</TooltipTrigger>
			) : (
```

In `BkdHeading` (value tooltip), replace:

```tsx
						<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
							<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
							<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
						</span>
```

with:

```tsx
						<TooltipTrigger
							tooltip={valueTooltip}
							align="right"
							className="text-right cursor-default"
							style={color ? { color } : undefined}
						>
							<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
						</TooltipTrigger>
```

In `BkdRow` (label tooltip), replace:

```tsx
					{tooltip ? (
						<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
							{label}
							<TooltipBubble align="left">{tooltip}</TooltipBubble>
						</span>
					) : (
```

with:

```tsx
					{tooltip ? (
						<TooltipTrigger
							tooltip={tooltip}
							align="left"
							className="cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit"
						>
							{label}
						</TooltipTrigger>
					) : (
```

In `BkdRow` (value tooltip), replace:

```tsx
				{valueTooltip ? (
					<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
						<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
						<TooltipBubble align="right">{valueTooltip}</TooltipBubble>
					</span>
				) : (
```

with:

```tsx
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
```

In `LegRouterTag` (the `path.length > 2` branch), replace:

```tsx
	return (
		<span className="group relative">
			{link}
			<TooltipBubble align="left">
				{router.path.map((slug) => formatProvider(slug, { full: true })).join(' → ')}
			</TooltipBubble>
		</span>
	);
```

with:

```tsx
	return (
		<TooltipTrigger tooltip={router.path.map((slug) => formatProvider(slug, { full: true })).join(' → ')} align="left" className="">
			{link}
		</TooltipTrigger>
	);
```

- [ ] **Step 6: Run tests to verify no regressions**

Run from repo root: `npx vitest run packages/dashboard`
Expected: PASS — every existing test in `receiptView.test.tsx` (including the LegRouterTag depth-2/depth>2 tests and the Cost Breakdown tooltip-copy tests) stays green, plus the new Step 1 test.

- [ ] **Step 7: Manual verification (not automated — no interaction-testing library in this package)**

Start the dev server (`npm run dev` from `packages/dashboard`, or via the `run` skill) and, using browser dev tools' touch emulation (or a real mobile device/simulator):
1. Open any receipt with a tooltip (e.g. the "Gas Cost" row, or a Cost Breakdown heading).
2. Touch the tooltip trigger — confirm the tooltip appears instantly.
3. Touch elsewhere on the page — confirm the tooltip disappears.
4. Confirm hovering with a mouse still works exactly as before.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): add press-and-hold tooltip support for touch devices"
```

---

### Task 4: Receipt pending-pulse

**Files:**
- Modify: `packages/dashboard/components/receiptSearch.tsx`
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/styles/globals.css`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Produces: `pendingPulseClass(isPending: boolean): string | undefined`, exported from `receiptView.tsx`.
- `ReceiptSearch`'s props gain two required fields: `isPending: boolean` and `startTransition: (callback: () => void) => void`. It no longer calls `useTransition()` itself.
- Consumes: React's built-in `useTransition()` (called once, in `ReceiptView`).

- [ ] **Step 1: Write the failing test for the pure helper**

Add to `packages/dashboard/components/receiptView.test.tsx` (new top-level `describe`, e.g. after the `tooltip touch support` block added in Task 3):

```tsx
describe('pendingPulseClass', () => {
	it('returns the pulse class while pending, and nothing otherwise', async () => {
		const { pendingPulseClass } = await import('./receiptView');
		expect(pendingPulseClass(true)).toBe('receipt-pending-pulse');
		expect(pendingPulseClass(false)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t "returns the pulse class"`
Expected: FAIL — `pendingPulseClass` is not exported yet.

- [ ] **Step 3: Add the CSS keyframes and class**

In `packages/dashboard/styles/globals.css`, add after the existing `.tx-row-enter` block:

```css
/*
 * Pulses the still-mounted receipt while a next one is being analyzed (Figma
 * 701-1986). Navigating between receipts is wrapped in startTransition, so
 * Next.js keeps the OLD receipt on screen instead of showing loading.tsx — this
 * pulse is the only feedback during that window.
 */
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

- [ ] **Step 4: Lift `useTransition` from `ReceiptSearch` into `ReceiptView`**

In `packages/dashboard/components/receiptSearch.tsx`:

Change the import line (currently `import { useEffect, useRef, useState, useTransition } from 'react';`) to:

```tsx
import { useEffect, useRef, useState } from 'react';
```

Change the component signature (currently `export function ReceiptSearch({ hash, failure }: { hash: string; failure?: AnalyzeFailure }) {`) to:

```tsx
export function ReceiptSearch({
	hash,
	isPending,
	startTransition,
	failure,
}: {
	hash: string;
	isPending: boolean;
	startTransition: (callback: () => void) => void;
	failure?: AnalyzeFailure;
}) {
```

Remove this line from the component body (no longer created locally):

```tsx
	const [isPending, startTransition] = useTransition();
```

Everything else in `receiptSearch.tsx` (the `go`, `submit`, JSX) is unchanged — it already reads `isPending` and calls `startTransition`, now sourced from props instead of a local hook call.

- [ ] **Step 5: Wrap the receipt in the pulse class from `ReceiptView`**

In `packages/dashboard/components/receiptView.tsx`, add to the top of the imports:

```tsx
import { useTransition } from 'react';
```

Replace the `ReceiptView` function body:

```tsx
export function ReceiptView({
	trade,
	hash,
	diagnosis,
}: {
	trade: ReceiptModel | null;
	hash: string;
	diagnosis?: AnalyzeFailure;
}) {
	const [isPending, startTransition] = useTransition();
	// Only surface a failure when there is no receipt to show.
	const failure = trade === null ? diagnosis : undefined;

	return (
		<div className="flex flex-col gap-[40px]">
			<ReceiptSearch
				hash={hash}
				isPending={isPending}
				startTransition={startTransition}
				{...(failure ? { failure } : {})}
			/>
			{/* The rule under the input renders in EVERY state, including the empty
			    page (Figma 544-2386) — which is why it lives here and not at the top
			    of <Receipt>. */}
			<Divider />
			{trade != null && (
				<div className={pendingPulseClass(isPending)}>
					<Receipt row={trade} />
				</div>
			)}
		</div>
	);
}

/**
 * Pure so it's testable without a real transition: the class that pulses the
 * still-mounted receipt while a next one is being analyzed (Figma 701-1986,
 * .receipt-pending-pulse in globals.css).
 */
export function pendingPulseClass(isPending: boolean): string | undefined {
	return isPending ? 'receipt-pending-pulse' : undefined;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t "returns the pulse class"`
Expected: PASS.

- [ ] **Step 7: Run the full dashboard suite for regressions**

Run from repo root: `npx vitest run packages/dashboard`
Expected: PASS. In particular, every existing `renderToStaticMarkup(<ReceiptView ... />)` test still passes: `useTransition()` returns `[false, startTransitionFn]` on an initial static render, so `pendingPulseClass(false)` is `undefined` and the wrapping `<div>` renders with no `className` attribute — identical markup around `<Receipt>`'s content to before this change, just with one extra (unstyled) wrapping `<div>`. Confirm none of the existing tests assert an exact parent/child DOM relationship that a new wrapping `<div>` would break (they are all `toContain`/`indexOf` substring checks on the full HTML string, so this should be safe — but verify by running the suite, not by inspection alone).

- [ ] **Step 8: Manual verification (not automated — no interaction-testing library in this package)**

Start the dev server and:
1. Load a receipt (e.g. `/tx/base/<a-known-good-hash>`).
2. Paste a *different* valid transaction hash into the search box (or type one and hit Enter).
3. Confirm the previously-loaded receipt stays visible and pulses — opacity cycling 100%→50%→100% smoothly, linear, roughly twice a second — until the new receipt replaces it.
4. Confirm the search button still shows its "Analyzing…"-style label during the same window.
5. In dev tools, enable "prefers-reduced-motion: reduce" and repeat — confirm the receipt shows a static dim (no animation) instead of pulsing.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/components/receiptSearch.tsx packages/dashboard/components/receiptView.tsx packages/dashboard/styles/globals.css packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): pulse the still-mounted receipt while the next one loads"
```
