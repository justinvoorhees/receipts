# Receipt UI — Figma v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the receipt page to the Figma v3 frames — new wordmark, a 40px page rhythm, 34px list items, no dotted dividers, a restyled share bar and footer, a `/methodology` route, favicons, and Execution Delta restated as a sentence.

**Architecture:** Render-layer only. No pricing change, no schema change, no migration, no repopulation. Row-height behavior is added as explicit opt-in props (`hug` on `DetailRow`, `standalone` on the two Cost-Breakdown row components) rather than inferred from other props, so a future row cannot silently pick the wrong regime. The one semantic change (Execution Delta) reuses the existing Price-Delta sentence builder.

**Tech Stack:** Next.js 15 (app router), React 19, Tailwind v4, vitest + `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-07-28-receipt-ui-figma-v3-design.md`

## Global Constraints

- **Tailwind spacing scale is customized:** `--spacing: 0.125rem`, so `pt-20` = 40px, `mt-10` = 20px. Prefer explicit `[40px]` / `[20px]` arbitrary values in new code to avoid ambiguity. Never assume the default Tailwind scale.
- **Row heights use `min-height`, never fixed height.** `min-h-[34px]`.
- **Tab title is exactly** `Receipts - Onchain transaction cost analysis` — ASCII hyphen `-` (U+002D), **not** an en dash (U+2013).
- **Never run `next build` while a dev server is running** — it writes into the same `.next` the dev server owns and breaks CSS. Use `npx tsc --build` from the repo root to typecheck core.
- **Do not modify the History dialog's Share or Delete buttons.** `Receipt` renders in two contexts; `onClose == null` distinguishes the standalone page from the dialog. All button restyling is gated on that predicate.
- **Do not touch `execResultUsd`, `receiptDollars`, or any file under `packages/core/`.** This is a dashboard-only change.
- Test commands from repo root:
  - Per-task: `npx vitest run packages/dashboard` — ⚠️ the positional arg is a **filename substring filter**, not a path. It happens to select the dashboard's files, but it is a filter, so never read its count as a whole-repo total.
  - Whole-repo gate: `npm test` (= `vitest run`, no filter). Use this in Task 11.
  - `-t '<name>'` filters by test *name*, also a substring match.
  - There is no `vitest.config.*` in this repo; vitest runs on defaults.
- Typecheck: `npx tsc --build` (= `npm run typecheck`). Lint: `npm run lint` (= `eslint packages`).
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## Two traps that have burned this repo before

1. **Substring trap.** `Execution Delta` is a prefix of `Total Execution Delta`. Any *absence* assertion must anchor on `'>Label<'`, never a bare `not.toContain('Execution Delta')`.
2. **Slice-helper trap.** `receiptView.test.tsx:570` defines `lpFeeSection(html)` as `html.slice(indexOf('Liquidity Provider Fee'), indexOf('Price Impact'))`. If section order changes the slice inverts and returns `''`, making every `not.toContain` inside it pass vacuously. It already throws on an inverted range — keep that guard working.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/dashboard/public/receipts-logo.svg` | **create** — RECEIPTS wordmark, used as a CSS mask |
| `packages/dashboard/public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png` | **create** — copied from `~/Downloads/fabric-favicons` |
| `packages/dashboard/app/layout.tsx` | **modify** — metadata (title/icons), drop the `<hr>`, main spacing |
| `packages/dashboard/app/methodology/page.tsx` | **create** — static prose page |
| `packages/dashboard/app/trades/page.tsx` | **modify** — own leading divider (was inherited from layout) |
| `packages/dashboard/components/header.tsx` | **modify** — RECEIPTS wordmark + dimensions |
| `packages/dashboard/components/footer.tsx` | **modify** — links row, drop `border-t` |
| `packages/dashboard/components/receiptSearch.tsx` | **modify** — drop label, new placeholder |
| `packages/dashboard/components/receiptView.tsx` | **modify** — dividers, Market Price composite, Execution Delta, share gating |
| `packages/dashboard/components/receipt/receiptRows.tsx` | **modify** — `hug` / `standalone` props, drop `dashed` |
| `packages/dashboard/components/receipt/priceFormat.ts` | **modify** — `formatExecutionDelta` + extracted sentence helpers |
| `packages/dashboard/components/receipt/qualityNotionals.ts` | **modify** — delete `formatExecutionResult` |
| `packages/dashboard/components/receipt/receiptDisplay.tsx` | **modify** — `ShareButton` `large` variant |

---

### Task 1: Assets and document metadata

Static assets plus the `<head>`. Nothing depends on this visually, so it lands first and unblocks browser checks.

**Files:**
- Create: `packages/dashboard/public/receipts-logo.svg`
- Create: `packages/dashboard/public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`
- Modify: `packages/dashboard/app/layout.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `/receipts-logo.svg` (Task 2 masks it), favicon files at `/`.

- [ ] **Step 1: Copy the favicons**

```bash
cp ~/Downloads/fabric-favicons/favicon.ico \
   ~/Downloads/fabric-favicons/favicon-16x16.png \
   ~/Downloads/fabric-favicons/favicon-32x32.png \
   packages/dashboard/public/
ls -la packages/dashboard/public/
```

Expected: three new files alongside `fabric-logo-h-black.svg` and `fonts/`.

There is no 180px source, so **do not** emit an `apple-touch-icon` tag — an upscaled 32px icon looks worse than none.

- [ ] **Step 2: Write the logo SVG**

The wordmark was exported from Figma node `546-636`. It is 8 solid `#0F0F0F` paths on a `0 0 720 40` viewBox, but the glyphs only occupy the leftmost 120.505px — the rest is empty frame. Tighten the viewBox so `mask-size: contain` scales the glyphs, not the whitespace.

A verbatim copy of the export lives at:
`/private/tmp/claude-501/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/a12d1aac-be92-489d-8d94-46c8302123cf/scratchpad/receipts-logo.svg`

```bash
cp "/private/tmp/claude-501/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/a12d1aac-be92-489d-8d94-46c8302123cf/scratchpad/receipts-logo.svg" \
   packages/dashboard/public/receipts-logo.svg
```

Then edit **only** the opening `<svg>` tag of `packages/dashboard/public/receipts-logo.svg`, replacing `width="720" height="40" viewBox="0 0 720 40"` with `width="121" height="40" viewBox="0 0 120.505 40"`. Leave `preserveAspectRatio`, the `<g>` wrappers, and all 8 `<path d="…">` elements byte-identical.

If that scratchpad file is gone, re-export it:
`mcp__claude_ai_Figma__download_assets({ fileKey: 'f9uYixaSgpkV1lEvN8Ie01', nodeId: '546:636' })` and download the single entry in `svgAssets`.

- [ ] **Step 3: Verify the SVG is a valid standalone mask source**

```bash
head -c 200 packages/dashboard/public/receipts-logo.svg
grep -c '<path' packages/dashboard/public/receipts-logo.svg
```

Expected: the opening tag shows `viewBox="0 0 120.505 40"`, and the path count is `8`.

- [ ] **Step 4: Update document metadata**

In `packages/dashboard/app/layout.tsx`, replace the `metadata` export:

```tsx
export const metadata = {
	title: 'Receipts - Onchain transaction cost analysis',
	description: 'Transaction cost analysis for aggregator-routed swaps on Base.',
	icons: {
		icon: [
			{ url: '/favicon.ico', sizes: 'any' },
			{ url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
			{ url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
		],
	},
};
```

⚠️ The title uses an ASCII hyphen. Confirm with `grep -c 'Receipts - Onchain' packages/dashboard/app/layout.tsx` → expect `1`.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/public packages/dashboard/app/layout.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): add the RECEIPTS wordmark, favicons, and the new tab title

viewBox tightened from 720x40 to 120.505x40 so mask-size:contain scales the
glyphs rather than the empty Figma frame. No apple-touch-icon: no 180px
source was provided and upscaling a 32px PNG looks worse than omitting it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Header wordmark and the page's top rhythm

**Files:**
- Modify: `packages/dashboard/components/header.tsx`
- Modify: `packages/dashboard/app/layout.tsx`
- Modify: `packages/dashboard/app/trades/page.tsx`

**Interfaces:**
- Consumes: `/receipts-logo.svg` (Task 1).
- Produces: a layout with **no** `<hr>` under the header. Task 4 relies on this — the page's only top divider will come from `ReceiptView`.

**Context:** the target rhythm is `logo(40) → 40 → input(40) → 40 → divider`. Today there are *two* rules (one under the logo from `layout.tsx`, one at the top of `Receipt`). The one under the logo goes; the other moves in Task 4.

`/trades` currently inherits the layout `<hr>`. It is not in the Figma frames, so it gets its own divider to preserve today's appearance rather than silently losing a rule.

- [ ] **Step 1: Swap the wordmark**

In `packages/dashboard/components/header.tsx`, replace the two constants and both mask URLs. The aspect ratio changes from 512:139 to 120.505:40.

```tsx
// Native aspect ratio of the RECEIPTS wordmark is 120.505:40 (~3.013).
// At 40px tall the rendered width is 120.505px.
const LOGO_HEIGHT = 40;
const LOGO_WIDTH = (LOGO_HEIGHT * 120.505) / 40;
```

Update the `<a>`'s `aria-label` from `"Fabric — home"` to `"Receipts — home"`, and both `WebkitMaskImage` / `maskImage` values from `url(/fabric-logo-h-black.svg)` to `url(/receipts-logo.svg)`.

Leave the CSS-mask technique and its explanatory comment intact — it is what makes the wordmark adopt `--color-primary` on the dark, coffee, and terminal themes. Leave `NavTabs` and `ThemePicker` alone (`NavTabs` is deliberately `opacity-0`: hidden but still clickable).

- [ ] **Step 2: Drop the layout rule and space `main`**

In `packages/dashboard/app/layout.tsx`, delete the `<hr …/>` line entirely and leave `<main>` as-is:

```tsx
		<html lang="en">
			<body>
				<Header />
				<main className="max-w-[720px] mx-auto">{children}</main>
				<Footer />
			</body>
		</html>
```

The 40px between logo and input already comes from `app/page.tsx`'s `<div className="mt-[40px]">` wrapper — do not add a second margin here or the gap doubles.

- [ ] **Step 3: Give `/trades` its own divider**

`packages/dashboard/app/trades/page.tsx` opens with `<div className="pb-5">` whose first child is `<div className="flex items-end justify-between mt-[40px]">` (the History heading row). Add the import:

```tsx
import { Divider } from '../../components/receipt/receiptRows';
```

and insert the rule as the new first child of the `pb-5` wrapper:

```tsx
	return (
		<div className="pb-5">
			{/* The layout's <hr> was removed in the Figma v3 pass; /trades is not in
			    the frames, so it renders its own rule to keep today's appearance. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
			<div className="flex items-end justify-between mt-[40px]">
```

The heading row already carries its own `mt-[40px]`, giving the same divider → 40px → title rhythm the receipt page uses.

- [ ] **Step 4: Verify the suite still passes**

Run: `npx vitest run packages/dashboard`
Expected: PASS. No test asserts on the layout `<hr>` or the logo, so this task should be green with no test edits. If `receiptView.test.tsx:224` fails here, you have gone too far — that assertion is Task 5's to fix.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/header.tsx packages/dashboard/app/layout.tsx packages/dashboard/app/trades/page.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): RECEIPTS wordmark, drop the rule under the logo

The page's top rhythm becomes logo -> 40 -> input -> 40 -> divider, so the
layout's <hr> goes; ReceiptView takes over the surviving rule. /trades is
not in the Figma frames and renders its own divider to keep today's look.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Footer

**Files:**
- Modify: `packages/dashboard/components/footer.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a footer with no top border. Tasks 4/9 supply the rules above it.

**Geometry (node `547-1014`):** the footer row is 9px tall (cap height of 12px text). `Built by Fabric.` sits left; four links are right-aligned in a 377px group at x=343, at x-offsets 0 / 73 / 174 / 293 with widths 33 / 61 / 79 / 84 — i.e. a uniform **40px gap**. The frame has no top border; the rule above it is a separate element.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/components/footer.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('Footer', () => {
	it('renders the four links in order with their hrefs', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).toContain('https://docs.withfabric.xyz/');
		expect(html).toContain('https://spandex.sh/');
		expect(html).toContain('https://benchmark.withfabric.xyz/');
		expect(html).toContain('href="/methodology"');
		expect(html.indexOf('>Docs<')).toBeLessThan(html.indexOf('>spanDEX<'));
		expect(html.indexOf('>spanDEX<')).toBeLessThan(html.indexOf('>Quotebench<'));
		expect(html.indexOf('>Quotebench<')).toBeLessThan(html.indexOf('>Methodology<'));
	});

	it('keeps the Built by Fabric attribution', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).toContain('Built by');
		expect(html).toContain('https://withfabric.xyz');
	});

	it('carries no top border — the rule above it is a separate element', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).not.toContain('border-t');
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/footer.test.tsx`
Expected: FAIL — the links do not exist yet, and `border-t` is still present.

- [ ] **Step 3: Implement**

Replace `packages/dashboard/components/footer.tsx` entirely:

```tsx
// The rule above the footer is rendered by each page, not by the footer itself:
// on the receipt page it sits above the SHARE bar, on /methodology directly
// above this row. A border-t here would double it.
const LINKS: { label: string; href: string }[] = [
	{ label: 'Docs', href: 'https://docs.withfabric.xyz/' },
	{ label: 'spanDEX', href: 'https://spandex.sh/' },
	{ label: 'Quotebench', href: 'https://benchmark.withfabric.xyz/' },
	{ label: 'Methodology', href: '/methodology' },
];

export function Footer() {
	return (
		<footer className="max-w-[720px] mx-auto mt-[40px] pb-[40px] flex items-center justify-between font-['Sohne_Breit'] text-[12px] leading-[12px]">
			<p>
				Built by{' '}
				<a href="https://withfabric.xyz" className="underline">
					Fabric
				</a>
				.
			</p>
			<nav className="flex items-center gap-[40px]">
				{LINKS.map((link) => (
					<a
						key={link.href}
						href={link.href}
						className="text-[var(--color-secondary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid hover:text-[var(--color-primary)]"
					>
						{link.label}
					</a>
				))}
			</nav>
		</footer>
	);
}
```

External links deliberately carry no `target="_blank"` — the existing `Built by Fabric` link does not either, and the frames give no indication. `/methodology` is internal and must stay same-tab regardless.

- [ ] **Step 4: Run the test**

Run: `npx vitest run packages/dashboard/components/footer.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run packages/dashboard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/footer.tsx packages/dashboard/components/footer.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): footer links row, drop the top border

Docs / spanDEX / Quotebench / Methodology, right-aligned on a 40px gap per
node 547-1014. The rule above the footer is now each page's own element, so
a border-t here would double it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Search field and the divider under the input

**Files:**
- Modify: `packages/dashboard/components/receiptSearch.tsx`
- Modify: `packages/dashboard/components/receiptView.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `ReceiptView` renders `<Divider />` unconditionally after `<ReceiptSearch>`. Task 5 removes the now-duplicate divider from `Receipt`'s top.

**Context:** the empty-state frame (`544-2386`) shows the rule under the input **with no receipt present**. Today that rule lives at the top of `Receipt`, so it vanishes on the empty page. Moving it into `ReceiptView` fixes the empty state and keeps the dialog (which renders `Receipt` directly) unaffected.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('ReceiptSearch chrome', () => {
	it('drops the Transaction Hash label and uses the short placeholder', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="" />);
		expect(html).not.toContain('Transaction Hash');
		expect(html).toContain('placeholder="Transaction hash"');
	});

	it('renders the divider under the input even with no receipt', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="" />);
		expect(html).toContain('h-px w-full shrink-0 bg-[var(--color-primary)]');
	});
});
```

Note the label/placeholder assertions differ only in the case of `H`/`h`, and `not.toContain('Transaction Hash')` is safe because the new placeholder is lowercase.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'ReceiptSearch chrome'`
Expected: FAIL — the label still renders and the empty state has no divider.

- [ ] **Step 3: Strip the label and change the placeholder**

In `packages/dashboard/components/receiptSearch.tsx`:

Replace the `PLACEHOLDER_HASH` constant:

```tsx
// Shown as greyed placeholder text in the empty search field.
const PLACEHOLDER_HASH = 'Transaction hash';
```

Delete the entire `<span>` block that renders `Transaction Hash` (the one styled `font-['Sohne_Breit'] text-[12px] leading-[12px]` with `style={{ color: labelColor }}`), and change the wrapper's `gap-[10px]` to `gap-[20px]` so the `FailureNotice` below keeps clear separation.

`labelColor` becomes unused — delete the `const labelColor = …` line too, or lint will flag it.

- [ ] **Step 4: Move the divider into `ReceiptView`**

In `packages/dashboard/components/receiptView.tsx`, replace the `ReceiptView` return body:

```tsx
	return (
		<div className="flex flex-col gap-[40px]">
			<ReceiptSearch hash={hash} {...(failure ? { failure } : {})} />
			{/* The rule under the input renders in EVERY state, including the empty
			    page (Figma 544-2386) — which is why it lives here and not at the top
			    of <Receipt>, where the dialog would also inherit it. */}
			<Divider />
			{trade != null && <Receipt row={trade} />}
		</div>
	);
```

`pb-10` is dropped: the footer now owns the trailing 40px via its own `mt-[40px]`.

- [ ] **Step 5: Run the test**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'ReceiptSearch chrome'`
Expected: PASS (2 tests).

The full suite is expected to have **one failure** at this point: `receiptView.test.tsx:224`, the dialog test asserting no primary divider. That is Task 5's to fix — do not patch it here.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receiptSearch.tsx packages/dashboard/components/receiptView.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): unlabeled search field, divider under the input

Placeholder becomes 'Transaction hash' and the standalone label is dropped.
The rule under the input moves from Receipt's top into ReceiptView so it
renders on the empty page too, per Figma 544-2386.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retire the dotted dividers, add the Cost Breakdown rule

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx`
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `Divider` from Task 4's usage.
- Produces: `Divider` with signature `({ color }: { color?: string })` — the `dashed` prop is **gone**. Later tasks must not pass it.

**Context:** neither table in any frame contains an internal rule. All six `<Divider dashed />` instances go, which leaves the `dashed` branch dead. One solid rule is added above the `Cost Breakdown` heading.

- [ ] **Step 1: Repair BOTH top-divider assertions first**

⚠️ **Corrected 2026-07-28 after Task 4.** An earlier draft of this step named only the dialog test. There are **two** tests using the same class substring as a proxy for "the top divider", and Task 4 broke both — one loudly, one silently:

- `receiptView.test.tsx:211` *"keeps the top divider and renders no close/delete controls outside the dialog"* — asserts `toContain(...)`. Task 4 moved the divider to `ReceiptView`, so `Receipt` standalone no longer has one and this test **fails now**.
- `receiptView.test.tsx:219` *"in dialog mode … omits the top divider …"* — asserts `not.toContain(...)`. It **passes vacuously** right now (there is no divider anywhere in `Receipt`), and will start failing the moment this task adds the Cost Breakdown rule.

Fix both, and do not let either keep using bare presence/absence of that class as a stand-in for position.

For the standalone test at line 211, drop the divider assertion entirely — the rule is no longer `Receipt`'s to render, and Task 4 already covers it in `ReceiptView` (*"renders the divider under the input even with no receipt"*). What remains is the control-absence claim the test name also makes:

```tsx
	it('renders no close/delete controls outside the dialog', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		// The rule under the input belongs to ReceiptView now, not Receipt — see
		// the 'ReceiptSearch chrome' block for its coverage.
		expect(html).not.toContain('Close transaction details');
		expect(html).not.toContain('>Delete<');
	});
```

For the dialog test at line 219, replace the absence assertion on line 224 with a position-anchored one:

```tsx
		// The dialog has no rule ABOVE its header — but it does carry the Cost
		// Breakdown rule further down, so assert ORDER, not absence. A bare
		// not.toContain here passes vacuously until a body divider exists, then
		// fails for the wrong reason.
		expect(html.indexOf('aria-label="Close transaction details"'))
			.toBeLessThan(html.indexOf('h-px w-full shrink-0 bg-[var(--color-primary)]'));
```

Also rename that test — it no longer "omits the top divider":
`'in dialog mode (onClose/onDelete passed), renders the close button beside the header and a Delete button above Share'`

- [ ] **Step 2: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('receipt dividers', () => {
	it('renders no dotted dividers anywhere', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).not.toContain('repeating-linear-gradient');
	});

	it('renders a primary rule immediately above the Cost Breakdown heading', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const heading = html.indexOf('>Cost Breakdown<');
		const rule = html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', heading);
		expect(heading).toBeGreaterThan(-1);
		expect(rule).toBeGreaterThan(-1);
		// Nothing but whitespace/markup between the rule and the heading.
		expect(html.slice(rule, heading)).not.toContain('Gas Cost');
	});
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'receipt dividers'`
Expected: FAIL — `repeating-linear-gradient` is present and there is no rule above the heading.

- [ ] **Step 4: Simplify `Divider`**

In `packages/dashboard/components/receipt/receiptRows.tsx`, replace the whole `Divider` function:

```tsx
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
```

- [ ] **Step 5: Remove every dashed divider and add the Cost Breakdown rule**

In `packages/dashboard/components/receiptView.tsx`:

1. Delete the leading `{onClose == null && <Divider color="primary" />}` — Task 4 moved it to `ReceiptView`. `Receipt` now opens directly on the `<div className="flex items-center justify-between">` header row.
2. Delete all six `<Divider dashed />` occurrences (three in the detail table, three in the Cost Breakdown).
3. Insert a rule immediately before the `Cost Breakdown` `<h2>`:

```tsx
			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Cost Breakdown
			</h2>
```

Both `Receipt` and its parent already stack children in a `gap-[40px]` / `gap-[20px]` flex column, so the rule needs no margin of its own.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/dashboard`
Expected: PASS, including the repaired dialog assertion from Step 1.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): retire dotted dividers, rule above Cost Breakdown

No Figma frame contains an internal table rule, so all six dashed dividers
go and Divider loses its `dashed` branch. The dialog test's absence proxy
became order-sensitive and is now position-anchored instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 34px list items

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx`
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `Divider` from Task 5.
- Produces:
  - `DetailRow` gains `hug?: boolean` (default `false`). `false` → `min-h-[34px]`; `true` → no floor. Task 7 passes `hug` on the Market Price row.
  - `BkdHeading` and `BkdRow` each gain `standalone?: boolean` (default `false`). `true` → `min-h-[34px]`.

**Context — two regimes, verified against frame geometry:**

- **Standalone rows** sit at 34px on a 54px pitch (34 + the container's existing 20px gap). Frame `546-631` detail rows: y = 0, 54, 108, 162, 216, 270, 324, 378. A row *with* a subvalue fills 34 exactly (12 + the existing `gap-[10px]` + 12); one without carries 22px of slack.
- **Group rows** — a heading plus its children — stay 12px on a 32px pitch, i.e. today's behavior. Frame `546-713`: heading at y=0, children at 32/64/96/128, all 12px tall.

Both live as siblings in the same `gap-[20px]` flex column, so only the floor differs. `min-height`, never fixed height, so a wrapped value grows instead of clipping.

**Which Cost Breakdown rows are standalone.** Five row identities spanning SIX JSX call sites (Slippage appears twice — a partial form and a costed form). All render a value; none sit under a heading:

| Call site | `standalone` |
| --- | --- |
| `BkdHeading label="Aggregator Fee"` **with** fee lines (group heading, no value) | no |
| `BkdHeading label="Aggregator Fee" value="0.00bps"` (no fee lines) | **yes** |
| fee-sink `BkdRow … secondary` | no |
| `BkdHeading label="Liquidity Provider Fee"` / `"Pools Touched"` | no |
| `LegRow` (renders a `BkdRow`) | no |
| `BkdRow label="No Route Found"` | no |
| `BkdHeading label="Price Impact"` **group form** (no value) | no |
| `BkdHeading label="Price Impact" value="n/a"` (partial form) | **yes** |
| `BkdHeading label="Slippage"` (both forms) | **yes** |
| `BkdHeading label="Positive Slippage"` | **yes** |
| `BkdRow label="Total Execution Delta"` | **yes** |

⚠️ Set the prop explicitly at each site. Do **not** infer it from `value != null && !secondary` — that happens to be correct today, but a future valueless standalone row would silently land in the wrong regime.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('list item heights', () => {
	it('floors detail rows at 34px', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const aggregator = html.indexOf('>Aggregator<');
		expect(aggregator).toBeGreaterThan(-1);
		// The row's own grid carries the floor; find the wrapper opening just before it.
		expect(html.lastIndexOf('min-h-[34px]', aggregator)).toBeGreaterThan(-1);
	});

	it('floors the four standalone breakdown rows but not the group rows', async () => {
		const { Receipt } = await import('./receiptView');
		const row = { ...fullUsdcWethRow, pricingStatus: 'full', routeLegs: [
			{ venue: '0x1111111111111111111111111111111111111111', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: 5, priceImpactBps: 1 },
		] };
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		// Total Execution Delta is standalone → floored.
		const total = html.indexOf('>Total Execution Delta<');
		expect(html.lastIndexOf('min-h-[34px]', total)).toBeGreaterThan(-1);
		// The LP Fee heading is a group heading → NOT floored. Assert that the
		// nearest wrapper before it is not a floored one by checking the slice
		// between the heading and its own grid contains no floor class.
		const lpHeading = html.indexOf('>Liquidity Provider Fee<');
		const gridBefore = html.lastIndexOf('grid grid-cols-', lpHeading);
		expect(html.slice(gridBefore, lpHeading)).not.toContain('min-h-[34px]');
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'list item heights'`
Expected: FAIL — `min-h-[34px]` appears nowhere yet.

- [ ] **Step 3: Add the floor to `DetailRow`**

In `packages/dashboard/components/receipt/receiptRows.tsx`, add `hug` to `DetailRow`'s props and apply it to the grid:

Add to the destructured params: `hug = false,`
Add to the type: 
```tsx
	/**
	 * Opts this row out of the 34px floor so it hugs its content. Only the Market
	 * Price row uses it: its methodology footnote sits 10px below the row inside a
	 * shared wrapper, so a floor here would push the footnote off its mark
	 * (Figma 546-687 = 34+10+36; 549-3112 = 12+10+36 when there is no subvalue).
	 */
	hug?: boolean;
```

Change the wrapper `<div>`:
```tsx
		<div className={`grid grid-cols-[180px_1fr] gap-x-[24px] ${hug ? '' : 'min-h-[34px]'}`}>
```

- [ ] **Step 4: Add the floor to the breakdown rows**

In the same file, add `standalone = false,` to both `BkdHeading` and `BkdRow`, with this doc on each:

```tsx
	/**
	 * A row that is not part of a heading+children group takes the 34px floor.
	 * Group members (fee sinks, legs, and the headings that own them) stay at
	 * 12px on the container's 20px gap — Figma 546-713.
	 */
	standalone?: boolean;
```

Then change both grid wrappers:
```tsx
		<div className={`grid grid-cols-[1fr_92px] gap-x-[24px] ${standalone ? 'min-h-[34px]' : ''}`}>
```

`LegRow` forwards nothing — it renders group members only, so it keeps the default.

- [ ] **Step 5: Mark the four standalone call sites**

In `packages/dashboard/components/receiptView.tsx`, add `standalone` to exactly these, per the table above:

- the `<BkdHeading label="Aggregator Fee" value="0.00bps" plain />` in the **else** branch (not the one inside the fragment with fee lines)
- `<BkdHeading label="Price Impact" value="n/a" … />` in the **partial** branch (not the group-form one)
- both `<BkdHeading label="Slippage" … />` occurrences
- `<BkdHeading label="Positive Slippage" … />`
- `<BkdRow label="Total Execution Delta" … />`

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/dashboard`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): 34px floor on standalone rows

Detail rows and the four standalone Cost Breakdown rows take a 34px floor
on the container's existing 20px gap (54px pitch, Figma 546-631). Group
rows -- headings and their legs/fee sinks -- stay 12px per 546-713.

min-height rather than a fixed height so a wrapped value grows instead of
clipping. The regime is an explicit prop at each call site, never inferred
from `value != null && !secondary`: that reading is correct today but would
silently misplace a future valueless standalone row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Market Price composite

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `DetailRow`'s `hug` prop (Task 6).
- Produces: nothing new.

**Context.** Today the methodology descriptor renders as a `*`-footnote **after** Price Delta, gated on `hasMarketPrice`. Frames `546-687` and `549-3112` bind it to the Market Price row instead:

```
[Market Price row]   ← hugs: 34px with a USD subvalue, 12px without
  ↕ 10px
[footnote]           ← 36px, two lines at 18px leading
```

Arithmetic checks in both frames: usd = 34+10+36 = 80; token = 12+10+36 = 58. The next row sits 20px below the composite in each.

Three consequences: the `*` disappears from label and footnote (positional binding replaces the linkage); the footnote renders in **all three tiers**, including unpriced, where `549-2857` shows `Unavailable: No reliable market price could be calculated.` under `n/a`; and the Market Price row alone opts out of the 34px floor.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('Market Price composite', () => {
	const partialRow = { ...fullUsdcWethRow, pricingStatus: 'partial', marketMid: null, allInCostBps: null };

	it('places the methodology footnote between Market Price and Price Delta', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const market = html.indexOf('>Market Price<');
		const note = html.indexOf('Verified:');
		const delta = html.indexOf('>Price Delta<');
		expect(market).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(market);
		expect(delta).toBeGreaterThan(note);
	});

	it('drops the asterisk from the label and the footnote', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('>Market Price<');
		expect(html).not.toContain('Market Price*');
		expect(html).not.toContain('>*');
	});

	it('renders the footnote on the unpriced tier too', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={partialRow as never} />);
		expect(html).toContain('Unavailable: No reliable market price could be calculated.');
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'Market Price composite'`
Expected: FAIL — the footnote is after Price Delta, the label carries `*`, and the unpriced tier suppresses it.

- [ ] **Step 3: Implement the composite**

In `packages/dashboard/components/receiptView.tsx`, replace the Market Price `DetailRow`, the Price Delta `DetailRow`, and the trailing footnote `<p>` with:

```tsx
				{/* Market Price + its methodology descriptor are ONE list item: the
				    footnote sits 10px under the row (Figma 546-687 / 549-3112), which
				    is why the row hugs and the wrapper owns the gap. The old
				    `*`-linkage is gone — position carries it now. */}
				<div className="flex flex-col gap-[10px]">
					<DetailRow
						label="Market Price"
						hug
						subValue={marketUsdPerBase != null ? formatSubvalueUsd(marketUsdPerBase) : undefined}
						{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
					>
						{hasMarketPrice ? formatExecutionPrice(row.marketMid, base, quote) : 'n/a'}
						{hasMarketPrice && row.manipulationFlag ? (
							<span
								className="ml-2"
								style={{ color: 'var(--color-yellow)' }}
								title="Median pool mid deviates from the reference oracle by more than 0.5% at N-1"
							>
								⚠ Possible manipulation
							</span>
						) : null}
					</DetailRow>
					{/* Renders on every tier — the unpriced tier's descriptor is the
					    "Unavailable: …" string, which the frames show under `n/a`. */}
					<p className="text-[12px] leading-[18px] text-[var(--color-secondary)]">
						{methodologyText}
					</p>
				</div>

				<DetailRow
					label="Price Delta"
					subValue={priceDelta?.sub ?? undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
					{priceDelta?.text ?? 'n/a'}
				</DetailRow>
```

Note the label lost its `hasMarketPrice ? 'Market Price*' : 'Market Price'` ternary, and the standalone `{hasMarketPrice && <p>*{methodologyText}</p>}` block is deleted.

`methodologyText` already falls back to `fallbackMethodology(row.pricingStatus)` when the column is null, so the unpriced tier gets its string with no further change.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/dashboard`
Expected: PASS. If an older test asserted `Market Price*`, update it to `>Market Price<` — the asterisk is intentionally gone.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): bind the methodology footnote to Market Price

The descriptor moves above Price Delta and into a shared wrapper with the
Market Price row (row + 10px + footnote), so the row hugs its content
rather than taking the 34px floor: 34+10+36 with a USD subvalue, 12+10+36
without, matching 546-687 and 549-3112.

Positional binding replaces the `*` linkage, so the asterisk is dropped
from both label and footnote, and the footnote now renders on the unpriced
tier too -- 549-2857 shows it under `n/a`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Execution Delta as a sentence

**Files:**
- Modify: `packages/dashboard/components/receipt/priceFormat.ts`
- Modify: `packages/dashboard/components/receipt/qualityNotionals.ts`
- Modify: `packages/dashboard/components/receipt/qualityNotionals.test.ts`
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `PriceDeltaRow` (`{ text: string; sub: string | null }`), already exported from `priceFormat.ts`.
- Produces: `formatExecutionDelta(execResultUsd: number, base: string, baseIsOutput: boolean, tokenInLabel: string): PriceDeltaRow`.
- Removes: `formatExecutionResult` from `qualityNotionals.ts`.

**Context.** The row becomes Price Delta's twin — same sentence, different denominator:

```
Execution Delta   WBTC bought at $4.57 below Market Price
                                            Per 1 ETH
```

Magnitude and direction stay on **today's** source, `dollars.execResultUsd`. "Dollarized allInBps" is the same number, not a second candidate: core's `allInCostBps = (mid − realized)/mid × 10⁴` and the dashboard's `qualityBps = (realized/mid − 1) × 10⁴` are negatives of each other, so `|execResultUsd| = notionalIn × |allInCostBps| / 10⁴` identically.

Capitalization differs between the two rows and is deliberate — `Per 1 ETH` (capital, node `546-677`) vs `per 1 WBTC` (lowercase, node `546-695`). Match the frames exactly.

The value is **uncolored** and there is no `Gained`/`Lost`: direction lives in the prose, as it already does on Price Delta. Green stays on the bps rows at the bottom, where the frames do show it.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('formatExecutionDelta', () => {
	it('mirrors the Price Delta sentence with a Per {tokenIn} subvalue', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		// Bought the base with a gain → the fill landed BELOW the mid.
		expect(formatExecutionDelta(4.57, 'WBTC', true, '1 ETH')).toEqual({
			text: 'WBTC bought at $4.57 below Market Price',
			sub: 'Per 1 ETH',
		});
		// Sold the base with a gain → the fill landed ABOVE the mid.
		expect(formatExecutionDelta(5, 'WETH', false, '1000 USDC')).toEqual({
			text: 'WETH sold at $5.00 above Market Price',
			sub: 'Per 1000 USDC',
		});
	});

	it('renders a loss on the opposite side of the mid', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		expect(formatExecutionDelta(-4.57, 'WBTC', true, '1 ETH')).toEqual({
			text: 'WBTC bought at $4.57 above Market Price',
			sub: 'Per 1 ETH',
		});
	});

	it('renders an exact tie as None with no subvalue', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		expect(formatExecutionDelta(0, 'WBTC', true, '1 ETH')).toEqual({ text: 'None', sub: null });
	});
});
```

And append a render-level test:

```tsx
describe('Execution Delta row', () => {
	// ETH→WBTC: base = WBTC (output, anchor rank 0 < ETH's 1) → the user BOUGHT the base.
	const ethWbtcRow = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders the sentence and the Per {tokenIn} subvalue, not Gained/Lost', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtcRow as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Per 1 ETH');
		expect(html).not.toContain('Gained');
		expect(html).not.toContain('Lost');
	});

	it('leaves the sentence uncolored — green stays on the bps rows', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtcRow as never} />);
		const delta = html.indexOf('>Execution Delta<');
		const total = html.indexOf('>Total Execution Delta<');
		// The green hex must not appear in the Execution Delta row's own markup.
		expect(html.slice(delta, html.indexOf('>Execution Price<'))).not.toContain('#117d45');
		// …but the bps row below still carries it.
		expect(total).toBeGreaterThan(-1);
		expect(html).toContain('+25.53bps');
	});
});
```

⚠️ Every absence assertion above anchors on `'>Label<'`. A bare `not.toContain('Execution Delta')` would be a false negative — it is a prefix of `Total Execution Delta`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'formatExecutionDelta'`
Expected: FAIL — `formatExecutionDelta` is not exported.

- [ ] **Step 3: Extract the shared sentence helpers**

In `packages/dashboard/components/receipt/priceFormat.ts`, add above `priceDeltaSentence`:

```ts
/**
 * The sentence both delta rows share: base symbol, the verb implied by the trade
 * direction, the magnitude, and where the fill landed. Verb and direction stay
 * independent facts whose combination carries the verdict without stating one
 * (bought below / sold above are the favorable halves).
 */
function deltaSentence(base: string, baseIsOutput: boolean, magnitude: string, direction: 'above' | 'below'): string {
	return `${base} ${baseIsOutput ? 'bought' : 'sold'} at ${magnitude} ${direction} Market Price`;
}

/**
 * Where the fill landed, given a dollar result. A gain on a bought base means the
 * fill was BELOW the mid; a gain on a sold base means ABOVE. Shared so the
 * Execution Delta and Price Delta rows can never disagree about direction.
 */
function deltaDirection(gain: boolean, baseIsOutput: boolean): 'above' | 'below' {
	return gain === baseIsOutput ? 'below' : 'above';
}
```

Rewrite `priceDeltaSentence` to use it:

```ts
function priceDeltaSentence(
	base: string,
	baseIsOutput: boolean,
	magnitude: string,
	direction: 'above' | 'below',
): PriceDeltaRow {
	return { text: deltaSentence(base, baseIsOutput, magnitude, direction), sub: `per 1 ${base}` };
}
```

And simplify `formatPriceDeltaUsd`'s direction line to `const direction = deltaDirection(execResultUsd > 0, baseIsOutput);`.

- [ ] **Step 4: Add `formatExecutionDelta`**

Append to `packages/dashboard/components/receipt/priceFormat.ts`:

```ts
/**
 * The Execution Delta row: the same sentence Price Delta uses, but stating the gap
 * on THIS trade rather than per 1 base — so the subvalue qualifies it with the
 * amount actually paid in ("Per 1 ETH") instead of "per 1 {base}".
 *
 * `execResultUsd` is the dashboard's whole-trade dollar result. It is the same
 * quantity as the Total Execution Delta bps row at the foot of the receipt:
 * core's allInCostBps = (mid − realized)/mid × 10⁴ is the exact negative of the
 * qualityBps behind execResultUsd, so |execResultUsd| = notionalIn ×
 * |allInCostBps| / 10⁴. The two rows state one fact in USD and in bps.
 *
 * Note the capital "Per", against Price Delta's lowercase "per" — the frames
 * (546-677 vs 546-695) differ here deliberately.
 */
export function formatExecutionDelta(
	execResultUsd: number,
	base: string,
	baseIsOutput: boolean,
	tokenInLabel: string,
): PriceDeltaRow {
	if (execResultUsd === 0) return { text: 'None', sub: null };
	const direction = deltaDirection(execResultUsd > 0, baseIsOutput);
	const magnitude = formatSubvalueUsd(Math.abs(execResultUsd));
	return { text: deltaSentence(base, baseIsOutput, magnitude, direction), sub: `Per ${tokenInLabel}` };
}
```

- [ ] **Step 5: Delete `formatExecutionResult`**

In `packages/dashboard/components/receipt/qualityNotionals.ts`, delete the entire `formatExecutionResult` function and its doc comment. If `formatUsdMagnitude` becomes unused there, drop its import too — lint will tell you.

In `packages/dashboard/components/receipt/qualityNotionals.test.ts`, delete both `describe('formatExecutionResult')` blocks (around lines 16-28 and 65-82) and remove `formatExecutionResult` from the file's top-level import.

- [ ] **Step 6: Wire the row**

In `packages/dashboard/components/receiptView.tsx`:

Replace the import `import { receiptDollars, formatExecutionResult } from './receipt/qualityNotionals';` with `import { receiptDollars } from './receipt/qualityNotionals';`

Add `formatExecutionDelta` to the existing `./receipt/priceFormat` import list.

Replace `const execResult = dollars != null ? formatExecutionResult(dollars.execResultUsd) : null;` with:

```tsx
	// Execution Delta states the gap on THIS trade; Price Delta states it per 1 base.
	// Same sentence, same direction source — they can never disagree.
	const executionDelta =
		dollars != null
			? formatExecutionDelta(dollars.execResultUsd, base, baseIsOutput, formatTokenIn(row))
			: null;
```

Replace the row itself:

```tsx
					{executionDelta != null && (
						<DetailRow label="Execution Delta" subValue={executionDelta.sub ?? undefined}>
							{executionDelta.text}
						</DetailRow>
					)}
```

`valueColor` is gone — the row is uncolored.

- [ ] **Step 7: Repair the older Execution Delta assertions**

`receiptView.test.tsx` around line 685 asserts `expect(html).toContain('Gained')` in the `Price Delta row` describe. Replace that line with:

```tsx
		// Execution Delta now states direction in prose; the pairing it must preserve
		// is that a bought-below fill agrees with a positive Total Execution Delta.
		expect(html).toContain('Per 1 ETH');
```

Search for any other `Gained` / `Lost` assertion and update it the same way:
```bash
grep -rn "'Gained'\|'Lost'" packages/dashboard
```
Expected after the edits: no matches.

- [ ] **Step 8: Run the suite**

Run: `npx vitest run packages/dashboard`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/components/receipt packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): restate Execution Delta as a sentence

The row becomes Price Delta's twin -- same shared sentence, but stating the
gap on THIS trade with a "Per {tokenIn}" subvalue rather than per 1 base.
Magnitude and direction stay on today's source, execResultUsd: dollarizing
allInCostBps reaches the identical number, since allInCostBps is the exact
negative of the qualityBps behind it.

Direction now lives in the prose, so the value is uncolored and Gained/Lost
is gone; green stays on the bps rows where the frames show it. That leaves
formatExecutionResult with no caller, so it and its tests are deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: SHARE bar

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx`
- Modify: `packages/dashboard/components/receiptView.tsx`
- Modify: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `Divider` (Task 5).
- Produces: `ShareButton({ path?: string; large?: boolean })`. `large` defaults to `false`, preserving today's dialog rendering exactly.

**Context.** Node `547-1011`: a 720×69 bar with the glyphs `SHARE` measuring 165×29, i.e. ~40px Sohne Breit, 20px of space above and below. A rule sits 40px above it (`546-793`), and the footer 40px below.

⚠️ **The History dialog must not change.** `onClose == null` identifies the standalone page. Both the `large` bar and the rule above it are gated on it, so the dialog keeps its 40px `Share` and `Delete` buttons and gains no rule.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```tsx
describe('SHARE bar', () => {
	it('renders the large uppercase bar with a rule above it on the standalone page', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('>SHARE<');
		expect(html).toContain('h-[69px]');
		const share = html.indexOf('>SHARE<');
		expect(html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', share)).toBeGreaterThan(-1);
	});

	it('leaves the dialog buttons untouched', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={fullUsdcWethRow as never} onClose={() => {}} onDelete={() => {}} />,
		);
		expect(html).toContain('>Share<');
		expect(html).toContain('>Delete<');
		expect(html).not.toContain('>SHARE<');
		expect(html).not.toContain('h-[69px]');
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'SHARE bar'`
Expected: FAIL — no `>SHARE<`, no `h-[69px]`.

- [ ] **Step 3: Add the `large` variant**

In `packages/dashboard/components/receipt/receiptDisplay.tsx`, replace `ShareButton`:

```tsx
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

	return (
		<button
			type="button"
			onClick={handleClick}
			className={`flex w-full shrink-0 cursor-pointer items-center justify-center rounded-[2px] bg-[var(--color-primary)] font-['Sohne_Breit'] font-medium text-[var(--color-surface-base)] ${sizing}`}
			style={{ fontFeatureSettings: '"calt" 0' }}
		>
			{large ? (copied ? 'COPIED' : 'SHARE') : copied ? 'Copied' : 'Share'}
		</button>
	);
}
```

- [ ] **Step 4: Gate the bar and its rule**

In `packages/dashboard/components/receiptView.tsx`, replace the closing block:

```tsx
			{/* The rule above the share bar (Figma 546-793) belongs to the standalone
			    page only — the dialog's button area is deliberately unchanged. */}
			{onClose == null && <Divider />}

			<div className="flex flex-col gap-[10px]">
				{onDelete != null && (
					<button
						type="button"
						onClick={onDelete}
						className="flex h-[40px] w-full shrink-0 cursor-pointer items-center justify-center bg-[var(--color-quaternary)] px-[20px] font-['Sohne_Breit'] font-medium text-[20px] leading-[20px] text-[var(--color-white)]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						Delete
					</button>
				)}
				<ShareButton large={onClose == null} {...(sharePath !== undefined ? { path: sharePath } : {})} />
			</div>
```

The Delete button is copied verbatim — do not restyle it.

- [ ] **Step 5: Run the suite**

Run: `npx vitest run packages/dashboard`
Expected: PASS, including the pre-existing dialog test at line 219.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receipt/receiptDisplay.tsx packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): 69px SHARE bar with a rule above it

Figma 547-1011: a full-width 69px bar with ~40px uppercase glyphs, and the
rule that used to sit between the button and the footer moved above it.

Both are gated on `onClose == null`, so the History dialog keeps its 40px
Share and Delete buttons and gains no rule -- explicitly out of scope.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `/methodology`

**Files:**
- Create: `packages/dashboard/app/methodology/page.tsx`
- Create: `packages/dashboard/app/methodology/page.test.tsx`

**Interfaces:**
- Consumes: `Divider` from `components/receipt/receiptRows`; `Footer`/`Header` come from the root layout automatically.
- Produces: the `/methodology` route the footer link (Task 3) targets.

**Geometry (node `549-2447`):** logo(40) → 40 → divider → 40 → title block → 40 → section → 40 → divider → 40 → footer. Inside the title block, `Methodology` is 20px cap-height (≈28px Sohne Breit) with `v0.1` 20px below it. Inside the section every prose block is separated by a uniform **20px** gap, and `Market Price` is a 14px-cap heading — the same 20px Sohne Breit as the receipt's `Cost Breakdown`.

Copy is transcribed verbatim from the frame.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/app/methodology/page.test.tsx`:

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
		expect(html.indexOf('WETH/USDC Price:')).toBeLessThan(html.indexOf('Direct-Pool Price:'));
		expect(html.indexOf('Direct-Pool Price:')).toBeLessThan(html.indexOf('WETH-Derived Price:'));
		expect(html.indexOf('WETH-Derived Price:')).toBeLessThan(html.indexOf('Oracle Reference:'));
	});

	it('states the measurement block and the Verified/Estimated rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('All market prices are measured at the block immediately before the transaction.');
		expect(html).toContain('When at least 2/3 methods agree, prices are Verified.');
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/dashboard/app/methodology/page.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the page**

Create `packages/dashboard/app/methodology/page.tsx`:

```tsx
import { Divider } from '../../components/receipt/receiptRows';

export const metadata = {
	title: 'Methodology - Receipts',
};

// Transcribed verbatim from Figma 549-2447. Prose only — no data access.
// Every block in the section is 20px apart; the page's outer rhythm is 40px.
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
	return <p className="text-[14px] leading-[20px] font-medium">{children}</p>;
}

function Body({ children }: { children: React.ReactNode }) {
	return <p className="text-[14px] leading-[20px]">{children}</p>;
}

export default function MethodologyPage() {
	return (
		<div className="mt-[40px] flex flex-col gap-[40px] font-['Sohne']">
			<Divider />

			<div className="flex flex-col gap-[20px]">
				<h1
					className="font-['Sohne_Breit'] font-medium text-[28px] leading-[28px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					Methodology
				</h1>
				<p className="text-[12px] leading-[12px] text-[var(--color-secondary)]">v0.1</p>
			</div>

			<div className="flex flex-col gap-[20px]">
				<Heading>Market Price</Heading>

				<Body>All market prices are measured at the block immediately before the transaction.</Body>

				<Label>WETH/USDC Price:</Label>
				<Body>
					The median price from three designated WETH/USDC liquidity pools, cross-referenced against
					an oracle reference. Used directly for WETH/USDC transactions or as a reference when pricing
					other token pairs.
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
					WETH-derived method are available, prices are Estimated.
				</Body>
			</div>

			<Divider />
		</div>
	);
}
```

The frame merges the Oracle Reference paragraph and the closing Verified/Estimated paragraph into one text node with a blank line between them; rendering them as two `<p>` on the same 20px gap is visually identical.

- [ ] **Step 4: Run the test**

Run: `npx vitest run packages/dashboard/app/methodology/page.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the suite**

Run: `npx vitest run packages/dashboard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/methodology
git commit -m "$(cat <<'EOF'
feat(dashboard): add the /methodology page

Prose transcribed verbatim from Figma 549-2447 on the page's 40px outer
rhythm and a uniform 20px gap between blocks. Static content only -- no
data access, no new dependency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Whole-branch verification

No production code changes here. This task exists because several of the traps in this repo only surface outside the unit suite.

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Typecheck the workspace**

Run from the repo root, with **no dev server running**:
```bash
npx tsc --build
```
Expected: clean. ⚠️ Do **not** run `npm run build` — `next build` writes into the same `.next` a running `next dev` owns and produces CSS 404s that look like a styling bug.

- [ ] **Step 2: Lint**

```bash
npm run lint
```
Expected: clean. Watch for newly-orphaned imports from Tasks 5 and 8 (`formatUsdMagnitude`, `labelColor`).

- [ ] **Step 3: Run the suite in BOTH env states**

The suite's result has been shell-dependent in this repo before — a `??` env fallback once passed vacuously with a clean env and failed with `.env` exported.

Use the **unfiltered** whole-repo command here, not the per-task filter:

```bash
npm test
set -a && source .env && set +a && npm test
```

⚠️ `source .env` alone does **not** export; the `set -a` wrapper is required.

Expected: identical PASS in both. Record the file/test counts from this unfiltered run — the historical "533 core tests" figure was fiction (inflated ~2.9x by stale worktrees plus substring filters), and the true count moves week to week. Cite only what you just measured.

Note a bare run skips the RPC end-to-end tests unless `TCA_RPC_URL` is exported; the second command above supplies it from `.env`, which is part of why both runs are required.

- [ ] **Step 4: Verify the slice helper did not go vacuous**

Task 7 moved the methodology footnote above Price Delta. `lpFeeSection` spans `Liquidity Provider Fee` → `Price Impact`, which that move does not cross, but confirm the guard is live rather than assuming:

```bash
npx vitest run packages/dashboard --reporter=verbose -t 'resolves the leading leg'
```
Expected: PASS. If `lpFeeSection` ever throws `LP Fee section not found before Price Impact`, section order broke — fix the order, do not weaken the helper.

- [ ] **Step 5: Browser-verify every state**

Start the dev server (`npm run dev -w @fabric-tca/dashboard`, port 3000) and check:

| State | How to reach it |
| --- | --- |
| empty | `/` with no `?tx=` |
| usd-priced | `/?tx=0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f` |
| unpriced | any receipt whose `pricingStatus` is `partial` |
| methodology | `/methodology` |
| History + dialog | `/trades`, then open a row |

Confirm for each: the 40px rhythm; 34px standalone rows against 12px group rows; no dotted rules; the footnote directly under Market Price with no asterisk; the SHARE bar at 69px; footer links; the tab title and favicon.

⚠️ On `/trades`, confirm the dialog's `Share` and `Delete` buttons are **visually unchanged** — that is an explicit constraint, not an inference.

- [ ] **Step 6: Check the themes**

Toggle through light, dark, and terminal via the theme picker. The RECEIPTS wordmark must recolor with `--color-primary` on each — that is the entire reason it is rendered as a CSS mask rather than a flat SVG.

- [ ] **Step 7: Check a narrow viewport**

Resize to ~380px wide and confirm no row clips. The `min-height` decision exists specifically so Execution Delta, Price Delta, and the FillerRow address can wrap and grow. If anything clips, a `min-h-[34px]` was written as `h-[34px]`.

- [ ] **Step 8: Commit any fixes**

If Steps 1-7 surfaced nothing, there is nothing to commit — say so plainly rather than manufacturing a commit.

---

## Self-Review

**Spec coverage.** Every numbered spec section maps to a task: §1 spacing → Tasks 2/4/5/9; §2 row heights → Task 6; §3 dotted dividers → Task 5; §4 Market Price → Task 7; §5 Execution Delta → Task 8; §6 chrome → Tasks 1/2/3/4/9; §7 methodology → Task 10. The spec's §9 verification notes are Task 11. Out-of-scope items (dialog buttons, `execResultUsd`, the earmarked rounding gap) are called out as constraints, not tasks.

**Type consistency.** `formatExecutionDelta` returns `PriceDeltaRow` (`{ text, sub }`), the same type `formatPriceDeltaUsd`/`formatPriceDeltaToken` already return, and `DetailRow`'s `subValue` accepts `React.ReactNode | undefined` — hence `executionDelta.sub ?? undefined` at the call site, since `sub` is `string | null`. `hug` and `standalone` are both `boolean` defaulting to `false`. `ShareButton`'s `large` is `boolean` defaulting to `false`.

**Ordering.** Task 4 removes the divider from `Receipt`'s top and Task 5 fixes the dialog assertion that depended on it — so the suite is expected red between those two tasks, and Task 4 Step 5 says so explicitly rather than leaving a surprise.
