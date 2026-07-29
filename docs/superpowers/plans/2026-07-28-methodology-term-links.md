# Methodology Term Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three fixed phrases (`direct-pool price`, `WETH-derived price`, `oracle reference`) inside the Market Price methodology footnote into dotted-underline links that open `/methodology` in a new tab, matching Figma frame `546-694`.

**Architecture:** One new presentational component, `MethodologyText`, added to `packages/dashboard/components/receipt/receiptRows.tsx` (where the receipt's other row/text helpers live). It splits a methodology sentence on a fixed 3-phrase alternation and wraps matches in `<a>`. `receiptView.tsx` swaps its current plain-text render of the footnote for this component. No new files, no new dependencies.

**Tech Stack:** React 18 + TypeScript, Tailwind utility classes, Vitest + `react-dom/server` `renderToStaticMarkup` (existing project test pattern — no React Testing Library in this codebase).

## Global Constraints

- The three linked phrases are exactly (case-sensitive): `direct-pool price`, `WETH-derived price`, `oracle reference` — verified exhaustive against every branch of `methodologyFor` in `packages/core/src/pricing.ts`. No other substring gets linked.
- Link styling must reuse the existing dotted/hover-solid classes verbatim: `underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid` (see `receiptRows.tsx:78`, `footer.tsx:26`).
- Links open in a new tab: `target="_blank" rel="noreferrer"`, `href="/methodology"`.
- Do not change any methodology sentence wording in `pricing.ts`.
- Do not touch any rendering outside the Market Price footnote.

---

### Task 1: Add the `MethodologyText` component

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Produces: `export function MethodologyText({ text }: { text: string }): JSX.Element` — renders `text` as a React fragment, with each occurrence of `direct-pool price` / `WETH-derived price` / `oracle reference` wrapped in a new-tab `/methodology` anchor, everything else left as plain text. Import path for consumers: `./receipt/receiptRows` (same module as `DetailRow`, `Divider`, etc.).

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/components/receiptView.test.tsx`, in a new top-level `describe` block placed after the existing `describe('Market Price composite', ...)` block (around line 1294):

```tsx
describe('MethodologyText', () => {
	it('wraps each of the three methodology phrases in a new-tab /methodology link', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Estimated: The direct-pool price and WETH-derived price disagree, and the oracle reference does not confirm their median." />,
		);
		for (const phrase of ['direct-pool price', 'WETH-derived price', 'oracle reference']) {
			const re = new RegExp(`<a[^>]*href="/methodology"[^>]*>${phrase}</a>`);
			expect(html).toMatch(re);
		}
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		// Surrounding prose survives untouched, outside any anchor.
		expect(html).toContain('Estimated: The ');
		expect(html).toContain(' does not confirm their median.');
	});

	it('renders text with no matching phrase as plain text, with no anchors', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Unavailable: No reliable market price could be calculated." />,
		);
		expect(html).toBe('Unavailable: No reliable market price could be calculated.');
		expect(html).not.toContain('<a');
	});

	it('links every phrase in a three-way agreement sentence', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Verified: The direct-pool price, WETH-derived price, and oracle reference agree." />,
		);
		for (const phrase of ['direct-pool price', 'WETH-derived price', 'oracle reference']) {
			const re = new RegExp(`<a[^>]*href="/methodology"[^>]*>${phrase}</a>`);
			expect(html).toMatch(re);
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- receiptView.test.tsx -t MethodologyText`
Expected: FAIL — `MethodologyText` is `undefined` (not yet exported from `receiptRows.tsx`), so React throws on the invalid element type.

- [ ] **Step 3: Implement `MethodologyText`**

Add to `packages/dashboard/components/receipt/receiptRows.tsx`, near the top-level helpers (after the `Divider` export, before `DetailRow`, so it reads as one of the shared text/row primitives):

```tsx
const METHODOLOGY_TERMS = ['direct-pool price', 'WETH-derived price', 'oracle reference'] as const;
const METHODOLOGY_PATTERN = new RegExp(`(${METHODOLOGY_TERMS.join('|')})`, 'g');

/**
 * Renders a Market Price methodology sentence (packages/core/src/pricing.ts
 * `methodologyFor`) with its three fixed phrases turned into dotted-underline
 * links to /methodology, opening in a new tab (Figma 546-694). The phrase list
 * is exhaustive — every sentence `methodologyFor` can produce is built only
 * from these three literal strings plus fixed prose — so a single
 * non-overlapping split is sufficient; no priority/longest-match logic needed.
 */
export function MethodologyText({ text }: { text: string }) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- receiptView.test.tsx -t MethodologyText`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): add MethodologyText for linked methodology phrases"
```

---

### Task 2: Wire `MethodologyText` into the Market Price footnote

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx:24-43` (import), `:229-231` (render)
- Modify: `packages/dashboard/components/receiptView.test.tsx:968-994` (fix the assertion broken by the anchor injection)

**Interfaces:**
- Consumes: `MethodologyText({ text }: { text: string })` from Task 1, imported from `./receipt/receiptRows`.

- [ ] **Step 1: Write the failing test (update the assertion the change will break)**

In `packages/dashboard/components/receiptView.test.tsx`, the test `'renders the Market Price descriptor as a footnote bound to the row on every tier'` (around line 968) currently does a raw-HTML `toContain` on the full sentence, which will no longer match verbatim once two of its phrases are wrapped in anchors. Replace line 974:

```tsx
		expect(stored).toContain('Verified: The direct-pool price and WETH-derived price agree.');
```

with:

```tsx
		expect(stored).toMatch(/<a[^>]*href="\/methodology"[^>]*>direct-pool price<\/a>/);
		expect(stored).toMatch(/<a[^>]*href="\/methodology"[^>]*>WETH-derived price<\/a>/);
		expect(stored).toContain('Verified: The ');
		expect(stored).toContain(' agree.');
```

Leave the rest of that test (lines 975-993) unchanged — `'Estimated:'`, the `'Unavailable: …'` full-sentence check (no phrase match, so it stays literal), and the removed-tooltip-copy checks are all unaffected by this change.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- receiptView.test.tsx -t "renders the Market Price descriptor"`
Expected: FAIL — the new regex assertions don't match yet because `receiptView.tsx` still renders `methodologyText` as a plain string (no anchors exist in the output).

- [ ] **Step 3: Wire the component in**

In `packages/dashboard/components/receiptView.tsx`, add `MethodologyText` to the existing `receiptRows` import block (lines 34-43):

```tsx
import {
	Divider,
	DetailRow,
	AggregatorValue,
	FillerRow,
	BkdHeading,
	BkdRow,
	LegRow,
	legContext,
	MethodologyText,
} from './receipt/receiptRows';
```

Then replace the footnote render (lines 227-231):

```tsx
					{/* Renders on every tier — the unpriced tier's descriptor is the
					    "Unavailable: …" string, which the frames show under `n/a`. */}
					<p className="text-[12px] leading-[18px] text-[var(--color-secondary)]">
						{methodologyText}
					</p>
```

with:

```tsx
					{/* Renders on every tier — the unpriced tier's descriptor is the
					    "Unavailable: …" string, which the frames show under `n/a`. Each
					    of the three methodology phrases (if present) links to
					    /methodology in a new tab (Figma 546-694). */}
					<p className="text-[12px] leading-[18px] text-[var(--color-secondary)]">
						<MethodologyText text={methodologyText} />
					</p>
```

- [ ] **Step 4: Run the full dashboard test suite to verify everything passes**

Run: `npm test`
Expected: PASS — every test file green, including the updated assertion and the new `MethodologyText` tests from Task 1. Pay particular attention to `receiptView.test.tsx` in full (not just the two touched tests), since the footnote renders on nearly every `Receipt` fixture in that file — confirm no other test in it does a raw-HTML `toContain` on a full methodology sentence that happens to include one of the three phrases (already checked during planning — only line 974 does — but re-verify against the live run, not the earlier grep).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): link methodology phrases to /methodology in a new tab"
```

---

## Manual verification (after both tasks)

- [ ] Start the dev server (`npm run dev`), open a receipt with a `full`, `estimated`, and `none` pricing tier (History tab has examples of each), and confirm:
  - The three phrases are dotted-underlined only where they actually appear in that tier's sentence.
  - Hovering a linked phrase switches the underline from dotted to solid.
  - Clicking a linked phrase opens `/methodology` in a **new** tab, leaving the receipt open underneath.
  - The `none`-tier "Unavailable: …" sentence renders with no links (it contains none of the three phrases).
