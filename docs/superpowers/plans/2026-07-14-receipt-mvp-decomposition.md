# Receipt MVP: Decomposition Over Judgment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the receipt answer "what happened in this trade" — fix the direction-blind Price Delta verdict, express Price Delta as a quote-denominated token delta, add a Size row, and remove every fair-value (USD) claim from the price block.

**Architecture:** Three edits to `ReceiptView.tsx` (pure helpers → render wiring → row removal), then a mechanical move of the now-unused "was this a good trade" helpers into a quarantined module that `ReceiptView` does not import. Core is untouched throughout. Each task leaves the suite green.

**Tech Stack:** TypeScript, React 19 (server-rendered via `renderToStaticMarkup`), Next 15, Vitest, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-07-14-receipt-mvp-decomposition-design.md`
**Figma:** https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=365-2911

## Global Constraints

- **Thesis:** the receipt answers *what happened in this trade*, not *was this a good trade*. No fair-value or per-side USD claims. `Size` is the only USD figure in the price block and is explicitly soft.
- **Never delete the "good trade" code.** It is quarantined with passing tests (Task 4), not removed.
- **Core (`packages/core`) is untouched.** `validateMid`, `tokenOracle`, and the `anchor_price_usd` column (migration 0014, already applied to Supabase) all stay and keep forward-populating.
- **Price Delta is computed from stored values, not displayed ones.** True delta at 6 sig figs → `0.0891927 ETH`. Figma's `0.0892` is the two rounded rows subtracted by hand; do not reproduce it.
- **Tab indentation** throughout (matches existing files).
- **All line numbers refer to the files as they stand at `33b3f1c`** (before Task 1). Earlier tasks shift them — **locate code by content, not by line number.**
- **Tests run from the repo root:** `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
- There is no vitest config in this repo; vitest's default `include` picks up new `*.test.ts` files automatically, so `receipt/qualityNotionals.test.ts` needs no registration.
- **Do not run `npm run lint`** — ESLint v9 config is missing repo-wide (pre-existing, out of scope).
- Reference row throughout is receipts `id=135`, txn `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f` (KyberSwap, Base, ETH→WBTC, `estimated` tier): `inputAmount '1'`, `outputAmount '0.02862539'`, `notionalUsd '1791.1353895147784'`, `marketMid '35.02321455049866'`, `realizedPrice '34.93402185961484'`, `allInCostBps '-25.53'`.

---

## Background: the bug being fixed

`priceDeltaComparison` (`ReceiptView.tsx:38`) hard-codes *higher execution price = better*:

```ts
if (exec > mid) return 'Below Market';   // tooltip: "better than Market Price"
return 'Above Market';                    // tooltip: "worse than Market Price"
```

That is only true when the user **sells** the base token. The base is the volatile leg chosen by `symbolAnchorRank` (stables `2` > ETH/WETH `1` > everything else `0`) — the **lower** rank is the base. When the base is the **output**, the user is buying it and a *lower* price is better, so the verdict inverts.

| Trade | Base | User is | `exec < mid` means |
|---|---|---|---|
| ETH→WBTC | WBTC (output) | buying WBTC | **better** |
| USDC→WETH | WETH (output) | buying WETH | **better** |
| WETH→USDC | WETH (input) | selling WETH | **worse** |
| PEPE→WETH | PEPE (input) | selling PEPE | **worse** |

Every buy-side receipt is affected. `ReceiptView.test.tsx:470` currently *asserts* the bug.

`Total Execution Quality` is **not** affected — it is computed in output-per-input via `signedDeviationBps` and negated at render (`ReceiptView.tsx:490`).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/dashboard/components/TradesTable.tsx` | Gains exported `formatPriceMagnitude` (extracted from `formatExecutionPrice`) and `ETH_SYMBOLS` (moved from `ReceiptView`, so the quarantine module can import it without importing `ReceiptView`). | 1, 4 |
| `packages/dashboard/components/ReceiptView.tsx` | Shrinks to pure decomposition. Loses `formatDelta`, `priceDeltaComparison`, `DetailRow.subvalue`, the Execution Result row, and all six quarantined helpers. | 1, 2, 3, 4 |
| `packages/dashboard/components/receipt/qualityNotionals.ts` | **New.** Quarantined "was this a good trade" helpers. Not imported by `ReceiptView`. | 4 |
| `packages/dashboard/components/receipt/qualityNotionals.test.ts` | **New.** Their tests, still running and passing. | 4 |
| `packages/dashboard/components/ReceiptView.test.tsx` | Rewritten Price Delta coverage incl. the sell direction (untested today). | 1, 2, 3, 4 |

---

### Task 1: Price Delta — direction-aware verdict, quote-denominated value

Replaces the inverted `Above/Below/At Market` subvalue with a dotted-underlined **value** carrying a direction-aware tooltip. Folds in the `DetailRow.valueTooltip` prop, which exists only to serve this row.

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx:353-368` (extract `formatPriceMagnitude`)
- Modify: `packages/dashboard/components/ReceiptView.tsx:30-62` (helpers), `:98-103` (`pairBaseQuote`), `:243-299` (`DetailRow`), `:515-532` (wiring), `:638-646` (row)
- Test: `packages/dashboard/components/ReceiptView.test.tsx:11-74` (replace), `:457-495` (replace)

**Interfaces:**
- Consumes: `STABLE_SYMBOLS` from `./TradesTable`.
- Produces:
  - `formatPriceMagnitude(n: number, quoteSymbol?: string): string` — exported from `TradesTable.tsx`
  - `formatPriceDelta(marketMid: unknown, realizedPrice: unknown, quoteSymbol: string): string` — exported from `ReceiptView.tsx`
  - `priceDeltaVerdict(marketMid: unknown, realizedPrice: unknown, baseIsOutput: boolean): 'better' | 'worse' | null` — exported from `ReceiptView.tsx`
  - `priceDeltaTooltip(base: string, baseIsOutput: boolean, verdict: 'better' | 'worse'): string` — exported from `ReceiptView.tsx`
  - `pairBaseQuote(row)` now returns `{ base: string; quote: string; baseIsOutput: boolean }`
  - `DetailRow` accepts `valueTooltip?: string`

- [ ] **Step 1: Write the failing tests**

In `packages/dashboard/components/ReceiptView.test.tsx`, **delete** the entire `describe('formatDelta', ...)` block (lines 11-39) and the entire `describe('priceDeltaComparison', ...)` block (lines 41-74), and replace both with:

```tsx
describe('formatPriceDelta', () => {
	it('renders the delta in the quote token at 6 significant figures', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		// Real ETH→WBTC row (receipts id 135), quote = ETH, base = WBTC.
		expect(formatPriceDelta(35.02321455049866, 34.93402185961484, 'ETH')).toBe('0.0891927 ETH');
	});

	it('renders the same magnitude when execution is above market', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(34.93402185961484, 35.02321455049866, 'ETH')).toBe('0.0891927 ETH');
	});

	it('renders a stablecoin-quoted delta at 2 decimals', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(3000, 2995, 'USDC')).toBe('5.00 USDC');
	});

	it('renders an exact tie as None', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(3000, 3000, 'USDC')).toBe('None');
	});

	it('renders a sub-cent memecoin delta at 6 sig figs rather than collapsing', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		// WARP→ETH: ETH-per-WARP. Float noise (8.99...e-12) must round away cleanly.
		expect(formatPriceDelta(0.000000000394, 0.000000000385, 'ETH')).toBe('0.000000000009 ETH');
	});

	it('returns – for null or non-finite inputs', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(null, 1829.0, 'USDC')).toBe('–');
		expect(formatPriceDelta(1830.0, null, 'USDC')).toBe('–');
	});
});

describe('priceDeltaVerdict', () => {
	// baseIsOutput === true  → user is BUYING the base  → cheaper is better
	// baseIsOutput === false → user is SELLING the base → dearer is better

	it('rates a cheaper fill better when buying the base (ETH→WBTC)', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(35.02321455049866, 34.93402185961484, true)).toBe('better');
	});

	it('rates a dearer fill worse when buying the base (ETH→WBTC)', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(34.93402185961484, 35.02321455049866, true)).toBe('worse');
	});

	it('rates a dearer fill better when selling the base (WETH→USDC)', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(3000, 3005, false)).toBe('better');
	});

	it('rates a cheaper fill worse when selling the base (WETH→USDC)', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(3000, 2995, false)).toBe('worse');
	});

	it('returns null for an exact tie', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(3000, 3000, true)).toBeNull();
		expect(priceDeltaVerdict(3000, 3000, false)).toBeNull();
	});

	it('returns null for null or non-finite inputs', async () => {
		const { priceDeltaVerdict } = await import('./ReceiptView');
		expect(priceDeltaVerdict(null, 3000, true)).toBeNull();
		expect(priceDeltaVerdict(3000, null, true)).toBeNull();
	});
});

describe('priceDeltaTooltip', () => {
	it('names the base token and the verb implied by the trade direction', async () => {
		const { priceDeltaTooltip } = await import('./ReceiptView');
		expect(priceDeltaTooltip('WBTC', true, 'better')).toBe('WBTC was bought at better than Market Price');
		expect(priceDeltaTooltip('WBTC', true, 'worse')).toBe('WBTC was bought at worse than Market Price');
		expect(priceDeltaTooltip('WETH', false, 'better')).toBe('WETH was sold at better than Market Price');
		expect(priceDeltaTooltip('WETH', false, 'worse')).toBe('WETH was sold at worse than Market Price');
	});
});
```

Then **delete** the entire `describe('Price Delta tooltip', ...)` block (lines 457-495 — its three render tests assert the inverted behavior) and replace it with:

```tsx
describe('Price Delta row', () => {
	// ETH→WBTC: base = WBTC (output, anchor rank 0 < ETH's 1) → the user BOUGHT the base.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders the quote-denominated delta with a "bought at better" tooltip, agreeing with Execution Quality', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		expect(html).toContain('0.0891927 ETH');
		expect(html).toContain('WBTC was bought at better than Market Price');
		// The verdict must agree with Total Execution Quality, which reads +25.53bps.
		expect(html).toContain('+25.53bps');
		// The old inverted labels are gone for good.
		expect(html).not.toContain('Above Market');
		expect(html).not.toContain('Below Market');
		expect(html).not.toContain('At Market');
	});

	it('rates the same pair worse when the fill is above the mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, realizedPrice: '35.11', allInCostBps: '25' } as never} />,
		);
		expect(html).toContain('WBTC was bought at worse than Market Price');
	});

	it('inverts the verdict for a sell (WETH→USDC), where the base is the input', async () => {
		const { Receipt } = await import('./ReceiptView');
		// base = WETH (input, rank 1 < USDC's 2) → the user SOLD the base.
		// Received 3005 USDC/WETH vs a 3000 mid → better.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow,
				inputSymbol: 'WETH', outputSymbol: 'USDC',
				inputToken: '0x4200000000000000000000000000000000000006',
				outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				inputAmount: '1', outputAmount: '3005',
				marketMid: '3000', realizedPrice: '3005',
			} as never} />,
		);
		expect(html).toContain('5.00 USDC');
		expect(html).toContain('WETH was sold at better than Market Price');
	});

	it('rates a sell worse when it received less than the mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow,
				inputSymbol: 'WETH', outputSymbol: 'USDC',
				inputToken: '0x4200000000000000000000000000000000000006',
				outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				inputAmount: '1', outputAmount: '2995',
				marketMid: '3000', realizedPrice: '2995',
			} as never} />,
		);
		expect(html).toContain('WETH was sold at worse than Market Price');
	});

	it('renders None with no tooltip when execution exactly matches the mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		// fullUsdcWethRow has marketMid === realizedPrice === '3000'.
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('None');
		expect(html).not.toContain('than Market Price');
	});

	it('renders a no-anchor memecoin pair through the same path, denominated in the quote token', async () => {
		const { Receipt } = await import('./ReceiptView');
		// LFI→GITLAWB (real row): neither leg anchors → tie in anchor rank →
		// base = input (LFI), quote = output (GITLAWB), marketMid is output-per-input.
		// Previously this rendered a total token quantity ("197178.79 GITLAWB") via
		// outputTokenDelta; it is now a per-base price delta like every other pair.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'fabric', pricingStatus: 'estimated',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3',
				outputToken: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3',
				inputAmount: '6745937.5', outputAmount: '7234145.96',
				marketMid: '1.1016', realizedPrice: '1.0724',
				allInCostBps: '265', chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('0.0292 GITLAWB');
		expect(html).not.toContain('197178.79 GITLAWB'); // the old quantity-based delta
		// base = LFI is the input → sold. 1.0724 < 1.1016 mid → received fewer → worse,
		// agreeing with allInCostBps 265 (a cost).
		expect(html).toContain('LFI was sold at worse than Market Price');
	});

	it('rates a USDC→WETH buy above the mid as worse (this assertion was inverted)', async () => {
		const { Receipt } = await import('./ReceiptView');
		// base = WETH (output, rank 1 < USDC's 2) → the user BOUGHT the base.
		// Paid 3005 USDC/WETH against a 3000 mid → a $5/ETH overpay → worse.
		// ReceiptView.test.tsx:470 previously asserted this was "better".
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, marketMid: '3000', realizedPrice: '3005' } as never} />,
		);
		expect(html).toContain('5.00 USDC');
		expect(html).toContain('WETH was bought at worse than Market Price');
	});
});
```

Finally, **fix the pre-existing render test that this task breaks.** In `describe('Receipt notional display (Phase 1)', ...)`, the test `no-anchor: no Execution Result, Price Delta reads in output tokens` (`ReceiptView.test.tsx:600-615`) asserts `expect(html).toContain('197178.79 GITLAWB')` — the old `outputTokenDelta` quantity. That row is now covered by the no-anchor test above. Delete that one test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`

Expected: FAIL. `formatPriceDelta`, `priceDeltaVerdict`, and `priceDeltaTooltip` are not exported — errors of the form `TypeError: formatPriceDelta is not a function`.

- [ ] **Step 3: Extract `formatPriceMagnitude` in `TradesTable.tsx`**

Replace `TradesTable.tsx:353-368` in full:

```tsx
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
```

- [ ] **Step 4: Replace the Price Delta helpers in `ReceiptView.tsx`**

Replace `ReceiptView.tsx:30-62` (`formatDelta`, `priceDeltaComparison`, and the old `priceDeltaTooltip`) in full:

```tsx
/**
 * Price Delta value: the gap between the market mid and the executed rate, in
 * the pair's quote token — the same quote-per-base convention the Execution and
 * Market Price rows above it use, formatted by the same rule. Unsigned; the
 * tooltip carries the verdict. Computed from the STORED values, not the rounded
 * ones on screen, so the delta is derived like every other number on the receipt.
 * An exact tie is "None" — there is no delta to describe, so no tooltip either.
 */
export function formatPriceDelta(marketMid: unknown, realizedPrice: unknown, quoteSymbol: string): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	const delta = Math.abs(mid - exec);
	if (delta === 0) return 'None';
	return `${formatPriceMagnitude(delta, quoteSymbol)} ${quoteSymbol}`;
}

/**
 * Was the fill better or worse than the mid? Direction-aware, and that is the
 * whole point: prices are quote-per-BASE, so a lower price is better only when
 * the user is BUYING the base (baseIsOutput). When the base is the input the
 * user is selling it and a higher price is better. Reading the sign without the
 * direction inverts the verdict on every buy — the bug this replaces.
 *
 * Reads the raw stored mid/realized in every case (USD-anchored, ETH-quoted, and
 * no-anchor alike): the display rescale that used to be applied is strictly
 * positive (marketUsd − execUsd = execUsd·(mm−rp)/rp, with execUsd > 0, rp > 0),
 * so it can never flip the sign. Null on an exact tie — matching formatPriceDelta's
 * "None", so the value and the tooltip can never disagree.
 */
export function priceDeltaVerdict(
	marketMid: unknown,
	realizedPrice: unknown,
	baseIsOutput: boolean,
): 'better' | 'worse' | null {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return null;
	if (exec === mid) return null;
	const better = baseIsOutput ? exec < mid : exec > mid;
	return better ? 'better' : 'worse';
}

/**
 * The base is always the bought token on a buy and the sold token on a sell —
 * that is what baseIsOutput means — so one flag picks both the token and the
 * verb. Naming the base is also what makes the tooltip describe the number on
 * screen, since Execution and Market Price are both quoted per base token.
 */
export function priceDeltaTooltip(base: string, baseIsOutput: boolean, verdict: 'better' | 'worse'): string {
	return `${base} was ${baseIsOutput ? 'bought' : 'sold'} at ${verdict} than Market Price`;
}
```

Update the `./TradesTable` import block at `ReceiptView.tsx:11-28`: **add** `formatPriceMagnitude`; **remove** `tokenUnitPriceUsd` and `formatTokenAmount` (their only uses — `tokenOutSubCent` at `:522` and `tokenDeltaText` at `:521` — both disappear in Step 7).

**Keep `formatUsdMagnitude`** — `formatExecutionResult` (`:206`) still uses it and stays in this file until Task 4.

Resulting import block:

```tsx
import {
	formatDialogBps,
	formatExecutionPrice,
	formatPriceMagnitude,
	formatSubvalueUsd,
	formatUsdMagnitude,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	legPairContext,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
	ShareButton,
	STABLE_SYMBOLS,
} from './TradesTable';
```

- [ ] **Step 5: Return `baseIsOutput` from `pairBaseQuote`**

Replace `ReceiptView.tsx:96-103`:

```tsx
// Resolves the base/quote symbols for a receipt's price rows, matching the
// orientation the DB already stores realizedPrice/marketMid in (quote-per-base).
// `baseIsOutput` is the trade direction relative to the base: true = the user
// bought the base, false = sold it. Price Delta's verdict depends on it.
function pairBaseQuote(row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol'>): {
	base: string;
	quote: string;
	baseIsOutput: boolean;
} {
	const baseIsOutput = symbolAnchorRank(row.outputSymbol) < symbolAnchorRank(row.inputSymbol);
	return baseIsOutput
		? { base: row.outputSymbol, quote: row.inputSymbol, baseIsOutput }
		: { base: row.inputSymbol, quote: row.outputSymbol, baseIsOutput };
}
```

- [ ] **Step 6: Add `valueTooltip` to `DetailRow`**

In `ReceiptView.tsx:243-257`, add `valueTooltip` to the props and the type (keep `subvalue`/`subvalueTooltip` — Task 3 removes them):

```tsx
function DetailRow({
	label,
	children,
	underscored = false,
	subvalue,
	tooltip,
	subvalueTooltip,
	valueTooltip,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	subvalue?: string | undefined;
	tooltip?: string;
	subvalueTooltip?: string;
	valueTooltip?: string;
}) {
```

Then replace the `subvalue == null` else-branch at `ReceiptView.tsx:294-296`:

```tsx
			) : valueTooltip ? (
				<span className="min-w-0 text-right">
					<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid">
						{children}
						<div
							role="tooltip"
							className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{valueTooltip}
						</div>
					</span>
				</span>
			) : (
				<span className="min-w-0 text-right">{children}</span>
			)}
```

- [ ] **Step 7: Wire the Price Delta row**

Replace `ReceiptView.tsx:515-532` (the `noAnchor` / `tokenDelta` / `tokenDeltaText` / `tokenOutSubCent` / `priceDeltaText` / `priceComparison` block) with:

```tsx
	// `noAnchor` still gates the Execution/Market Price USD sub-values (:601, :618)
	// until Task 3 removes them. Everything else here goes now.
	const noAnchor = !isAnchorable(row.inputSymbol) && !isAnchorable(row.outputSymbol);
	// Price Delta is quote-denominated in every case — anchored, ETH-quoted, and
	// no-anchor memecoin alike — because the stored mid/realized are already
	// quote-per-base. No USD, no tiers, one path.
	const priceDeltaText = hasMarketPrice
		? formatPriceDelta(row.marketMid, row.realizedPrice, quote)
		: undefined;
	const verdict = hasMarketPrice ? priceDeltaVerdict(row.marketMid, row.realizedPrice, baseIsOutput) : null;
	const priceDeltaTip = verdict ? priceDeltaTooltip(base, baseIsOutput, verdict) : undefined;
```

This deletes `tokenDelta`, `tokenDeltaText`, `tokenOutSubCent`, and `priceComparison`, and retains only `noAnchor`.

`base`/`quote` are already destructured at `ReceiptView.tsx:497`; change that line to also take `baseIsOutput`:

```tsx
	const { base, quote, baseIsOutput } = pairBaseQuote(row);
```

Then replace the Price Delta `DetailRow` at `ReceiptView.tsx:638-646`:

```tsx
				<DetailRow
					label="Price Delta"
					{...(priceDeltaTip ? { valueTooltip: priceDeltaTip } : {})}
				>
					{hasMarketPrice ? priceDeltaText : UNAVAILABLE}
				</DetailRow>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`

Expected: the `formatPriceDelta`, `priceDeltaVerdict`, `priceDeltaTooltip`, and `Price Delta row` blocks all PASS.

The whole file must be green. Two pre-existing tests are worth knowing about:

- `Receipt token-denominated price rows › renders ETH-quoted prices token-denominated with the quote symbol` asserts `toContain('$0.00')` for the USD sub-value. That sub-value is untouched by this task (Task 3 removes it), so this test still passes. Leave it alone.
- `Receipt notional display (Phase 1) › no-anchor: …` is the one this task deletes (see the end of Step 1) — it asserts the old `outputTokenDelta` quantity.

If any other test fails, fix the cause rather than the assertion.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --build`
Expected: clean. If it reports `formatUsdMagnitude`/`formatTokenAmount` as missing, re-add them to the `./TradesTable` import (see the note in Step 4).

- [ ] **Step 10: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "fix(dashboard): direction-aware Price Delta, quote-denominated

The Above/Below Market labels hard-coded 'higher execution price is
better', which is only true when selling the base token. Every buy-side
receipt — including the common USDC->WETH case — showed the inverted
verdict, contradicting Total Execution Quality on the same receipt.

Replace with a direction-aware verdict keyed off baseIsOutput, carried by
a tooltip on the value rather than an Above/Below label. Express the delta
in the pair's quote token (0.0891927 ETH) instead of USD, which collapses
the anchored / ETH-quoted / no-anchor branches into one path.

Adds the sell-direction test that no test covered before."
```

---

### Task 2: Size row and section dividers

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx:578` (insert Size), `:583` and `:646` (insert dividers)
- Test: `packages/dashboard/components/ReceiptView.test.tsx` (new describe block)

**Interfaces:**
- Consumes: `formatSubvalueUsd` from `./TradesTable`; `UNAVAILABLE` (`ReceiptView.tsx:226`); `<Divider dashed />` (`ReceiptView.tsx:228`); `row.notionalUsd`.
- Produces: nothing consumed by later tasks.

**Context:** `notionalUsd` needs no core work — it is already populated on all three tiers and already handles unanchored pairs (`getTokenUsdcValue`, `tokenPricing.ts:340`, tries token/USDC then token/WETH→WETH/USDC). Use it **as-is**; do not re-derive it as "the input side". `bestEffortNotional` (`pricing.ts:439`) deliberately prefers the *anchored* side because pricing an illiquid input directly is a known failure — a WARP→ETH swap hit a zero-liquidity WARP/USDC pool with a stale mid and inflated the notional ~7×.

The `Block | Size` divider **already exists** at `ReceiptView.tsx:576`. Only two dividers are new.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/components/ReceiptView.test.tsx`:

```tsx
describe('Size row', () => {
	it('renders the trade notional above Token In', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
				inputSymbol: 'ETH', outputSymbol: 'WBTC',
				inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
				inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
				marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
				chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('$1,791.14');
		// Size precedes Token In in the document.
		expect(html.indexOf('Size')).toBeLessThan(html.indexOf('Token In'));
	});

	it('renders Size on a partial receipt, where no mid exists', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'partial',
				marketMid: null, allInCostBps: null, notionalUsd: '1000.00',
			} as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('$1,000.00');
	});

	it('renders Size for a no-anchor memecoin pair', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'estimated',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x1111111111111111111111111111111111111111',
				outputToken: '0x2222222222222222222222222222222222222222',
				inputAmount: '1000', outputAmount: '2400', notionalUsd: '134.96',
				marketMid: '2.5', realizedPrice: '2.4', chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('$134.96');
	});

	it('falls back to the unavailable placeholder when there is no notional', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, notionalUsd: null } as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('Unavailable for this pair');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx -t "Size row"`
Expected: FAIL — `expect(html).toContain('Size')` fails; the row does not exist.

- [ ] **Step 3: Add the Size row**

Insert immediately **before** the `Token In` `DetailRow` (`ReceiptView.tsx:578`):

```tsx
				{/* Trade size at a glance. Deliberately soft — it claims nothing, and is
				    the only USD figure in this block. notionalUsd already prefers the
				    USD-anchored side (pricing.ts bestEffortNotional), which is why we use
				    it as-is rather than re-deriving the input side. */}
				<DetailRow label="Size">
					{row.notionalUsd == null ? UNAVAILABLE : formatSubvalueUsd(Number(row.notionalUsd))}
				</DetailRow>
```

- [ ] **Step 4: Add the two new dividers**

Insert **after** the `Token Out` `DetailRow` closing tag (`ReceiptView.tsx:583`, before the Execution Result block):

```tsx

				<Divider dashed />

```

Insert **after** the `Price Delta` `DetailRow` closing tag (before the `Gas Cost` `DetailRow` at `ReceiptView.tsx:647`):

```tsx

				<Divider dashed />

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: all PASS.

Note: `Receipt estimated pricing tier › shows Execution Price on a fully partial receipt` asserts exactly 2 occurrences of `Unavailable for this pair`. `fullUsdcWethRow` has `notionalUsd: '1000.00'`, so Size renders a value and the count stays 2. If it reports 3, Size is wrongly rendering the placeholder — fix the null check, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): add Size row and section dividers to the receipt

Size is the trade notional at a glance, rendered on every tier including
partial and no-anchor pairs. It uses notionalUsd as-is: that already
prefers the USD-anchored side, which is what keeps an illiquid input from
mis-valuing the trade.

Dividers per Figma 365:2911 — Token Out | Execution Price and Price Delta
| Gas Cost. The Block | Size divider already existed."
```

---

### Task 3: Hide Execution Result and the per-side notionals

Removes every "was this a good trade" claim from the render path. The helpers themselves are untouched here — Task 4 moves them.

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx:243-299` (drop `subvalue`), `:499-522` (drop the notional wiring), `:578-637` (drop Execution Result + subvalues)
- Test: `packages/dashboard/components/ReceiptView.test.tsx:213-237` (fix), `:661-685` and `:701-714` (delete), new absence tests

**Interfaces:**
- Consumes: nothing new.
- Produces: `DetailRow` reduced to `{ label, children, underscored?, tooltip?, valueTooltip? }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/components/ReceiptView.test.tsx`:

```tsx
describe('Receipt makes no fair-value claim (MVP thesis)', () => {
	// The ETH→WBTC row that used to render "Execution Result +$4.57" by marking
	// WBTC at the mid, and "-$0.47" via the BTC/USD oracle. Both are answers to
	// "was this a good trade" and no longer belong on the receipt.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders no Execution Result on a full-tier single-anchor pair', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).not.toContain('Execution Result');
		expect(html).not.toContain('$1,795.71'); // WBTC marked at the mid
		expect(html).not.toContain('+$4.57');
	});

	it('renders no Execution Result even with an independent oracle anchor present', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'estimated', anchorPriceUsd: '62000' } as never} />,
		);
		expect(html).not.toContain('Execution Result');
		expect(html).not.toContain('independent Chainlink oracle');
		expect(html).not.toContain('validated benchmark mid');
	});

	it('renders no per-side USD notionals on the token or price rows', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		// Token In / Token Out / Execution Price / Market Price carry no USD sub-value.
		// Size ($1,791.14) is the only USD figure above Gas Cost.
		expect(html).not.toContain('$62,731.32'); // Market Price in USD
		expect(html).not.toContain('$62,571.56'); // Execution Price in USD
		expect(html).toContain('$1,791.14');      // Size survives
		expect(html).toContain('34.934 ETH = 1 WBTC');
		expect(html).toContain('35.0232 ETH = 1 WBTC');
	});
});
```

Then **fix the pre-existing assertion** at `ReceiptView.test.tsx:232`. In `Receipt token-denominated price rows › renders ETH-quoted prices token-denominated with the quote symbol`, delete this line and its comment:

```tsx
		// The USD figure (previously shown on the main line) no longer appears there —
		// it still lives in the sub-value, so assert its presence rather than absence.
		expect(html).not.toContain('0.000000000385 = 1 WARP');
		expect(html).toContain('$0.00'); // USD sub-value still rendered (rounds to $0.00 at this scale)
```

and replace with:

```tsx
		expect(html).not.toContain('0.000000000385 = 1 WARP');
		// The USD sub-value is gone — the price rows make no USD claim.
		// (Execution Price sub-value was $0.000000667735 = notionalUsd / inputAmount.)
		expect(html).not.toContain('$0.000000667735');
```

> **Do not** write `expect(html).not.toContain('$0.00')` here. Gas Cost renders `$0.0010` (`formatGasUsd` is `toFixed(4)`), which *contains* the substring `$0.00`, so that assertion fails for an unrelated reason. It is also why the original `toContain('$0.00')` was passing regardless of the sub-value — its comment was wrong. Assert the exact sub-value string instead.

Finally **delete** the now-obsolete render tests, which assert the Execution Result row and per-side notionals that no longer exist:

- `describe('Receipt single-anchor validated display (Phase 2a)', ...)` — `ReceiptView.test.tsx:661-685` in full.
- Inside `describe('independent oracle anchor (Phase 2 WBTC)', ...)`, delete only the **second** test, `it('renders an estimated WBTC trade as both notionals via the independent oracle', ...)` (`:700-714`). Keep the first test — it covers `singleAnchorNotionals` as a pure function and moves to the quarantine module in Task 4.
- Inside `describe('Receipt notional display (Phase 1)', ...)`, delete the **first** test, `it('double-anchored: shows distinct per-side notionals and an Execution Result surplus', ...)` (`:583-598`) — it asserts `Execution Result`, `+$20.00`, `$1,020.00` and `$1,000.00`, all of which this task removes. Keep the remaining test (`single-anchor: no per-side notionals and no Execution Result`), which asserts absence and still passes. (Its sibling no-anchor test was already deleted in Task 1.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx -t "makes no fair-value claim"`
Expected: FAIL — `expect(html).not.toContain('Execution Result')` fails; the row still renders.

- [ ] **Step 3: Remove the Execution Result row**

Delete `ReceiptView.tsx:584-597` in full (the `{execResult && (...)}` block).

- [ ] **Step 4: Remove the subvalues from the four rows**

Replace the `Token In` and `Token Out` rows (`ReceiptView.tsx:578-583`):

```tsx
				<DetailRow label="Token In">{formatTokenIn(row)}</DetailRow>
				<DetailRow label="Token Out">{formatTokenOut(row)}</DetailRow>
```

Replace the `Execution Price` row (`ReceiptView.tsx:598-613`):

```tsx
				<DetailRow label="Execution Price">
					{row.realizedPrice == null
						? UNAVAILABLE
						: formatExecutionPrice(row.realizedPrice, base, quote)}
				</DetailRow>
```

Replace the `Market Price` row (`ReceiptView.tsx:614-637`):

```tsx
				<DetailRow label="Market Price" tooltip={marketTooltip}>
					{hasMarketPrice
						? formatExecutionPrice(row.marketMid, base, quote)
						: UNAVAILABLE}
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
```

- [ ] **Step 5: Remove the notional wiring**

Delete `ReceiptView.tsx:499-522` — the whole block from the `// Both-or-none per-side notionals.` comment through `const noAnchor = ...`. Specifically these consts and their comments: `midValidated`, `dbl`, `single`, `notionalIn`, `notionalOut`, `showPerSideNotionals`, `independentAnchor`, `markedAtMid`, `execResult`, `noAnchor`.

Also delete `const usdPrices = usdPerBasePrices(row);` (`ReceiptView.tsx:498`).

- [ ] **Step 6: Remove `subvalue`/`subvalueTooltip` from `DetailRow`**

All five call sites are gone. Replace `DetailRow` (`ReceiptView.tsx:243-299`) in full:

```tsx
function DetailRow({
	label,
	children,
	underscored = false,
	tooltip,
	valueTooltip,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	tooltip?: string;
	valueTooltip?: string;
}) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			{tooltip ? (
				<span className="group relative cursor-default text-[var(--color-primary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
					{label}
					<div
						role="tooltip"
						className="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
					>
						{tooltip}
					</div>
				</span>
			) : (
				<span
					className={`text-[var(--color-primary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
				>
					{label}
				</span>
			)}
			{valueTooltip ? (
				<span className="min-w-0 text-right">
					<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid">
						{children}
						<div
							role="tooltip"
							className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
						>
							{valueTooltip}
						</div>
					</span>
				</span>
			) : (
				<span className="min-w-0 text-right">{children}</span>
			)}
		</div>
	);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: all PASS. The `per-side notionals`, `singleAnchorNotionals`, and the surviving `independent oracle anchor` test still pass — they exercise the helpers directly, which still exist in this file.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --build`
Expected: clean. `perSideNotionals`, `singleAnchorNotionals`, `formatExecutionResult`, `isAnchorable`, `usdPerBasePrices`, `outputTokenDelta` and `usdPriceAtMid` are now unreferenced by the component but still exported and still tested — that is intended, and Task 4 relocates them.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): drop Execution Result and per-side notionals from the receipt

The receipt answers 'what happened in this trade', not 'was this a good
trade'. Answering both at once is what made it self-contradictory: the
reference ETH->WBTC row showed +25.53bps Execution Quality (vs the pool
mid) beside a negative Execution Result (vs the BTC/USD oracle), because
the pool mid itself sat ~28bps above BTC. Both true, different rulers.

Removes the Execution Result row and the USD sub-values on Token In,
Token Out, Execution Price and Market Price. Size is now the only USD
figure in the block, and is explicitly soft. DetailRow loses subvalue
along with its last caller.

The helpers stay put and stay tested; the next commit relocates them."
```

---

### Task 4: Quarantine the "was this a good trade" helpers

A mechanical move. Nothing imports these any more, but the work is valuable for the deferred phase, so it is preserved with its tests running rather than deleted or left to rot in place.

**Files:**
- Create: `packages/dashboard/components/receipt/qualityNotionals.ts`
- Create: `packages/dashboard/components/receipt/qualityNotionals.test.ts`
- Modify: `packages/dashboard/components/TradesTable.tsx:722` (export `ETH_SYMBOLS`)
- Modify: `packages/dashboard/components/ReceiptView.tsx:85` (import `ETH_SYMBOLS`), remove the six helpers
- Modify: `packages/dashboard/components/ReceiptView.test.tsx` (remove the moved describes)

**Interfaces:**
- Consumes: `ReceiptRow` from `../../lib/queries`; `STABLE_SYMBOLS`, `ETH_SYMBOLS`, `formatUsdMagnitude` from `../TradesTable`.
- Produces: `qualityNotionals.ts` exporting `isAnchorable`, `usdPerBasePrices`, `perSideNotionals`, `singleAnchorNotionals`, `formatExecutionResult`, `outputTokenDelta`.

**Why `ETH_SYMBOLS` moves:** it currently lives in `ReceiptView.tsx:85` and is used both by `symbolAnchorRank` (which stays) and by three of the moving helpers. The quarantine module must not import `ReceiptView` (a `'use client'` component), so `ETH_SYMBOLS` moves to `TradesTable.tsx` next to `STABLE_SYMBOLS`, and both files import it.

- [ ] **Step 1: Export `ETH_SYMBOLS` from `TradesTable.tsx`**

Add immediately after `TradesTable.tsx:722`:

```tsx
export const ETH_SYMBOLS = new Set(['WETH', 'ETH']);
```

- [ ] **Step 2: Create the quarantine module**

Create `packages/dashboard/components/receipt/qualityNotionals.ts`:

```tsx
/**
 * "Was this a good trade?" — deferred.
 *
 * These helpers value each side of a swap in USD and compare them, which is a
 * fair-value claim. The receipt currently answers only "what happened in this
 * trade" (see docs/superpowers/specs/2026-07-14-receipt-mvp-decomposition-design.md),
 * so nothing here is wired into ReceiptView.
 *
 * They are kept — with their tests running — because that question is worth
 * answering once the decomposition is validated. The known gap they exposed:
 * for the reference ETH→WBTC row, valuing WBTC at the BTC/USD oracle instead of
 * the pool mid turned an apparent +$4.57 into ≈flat, because the pool's WBTC
 * price sat ~28bps above real BTC. That "venue basis" term is what a future
 * phase needs to surface for the two numbers to reconcile under one ruler.
 *
 * Core still forward-populates `anchor_price_usd` (migration 0014), so this
 * resumes as a re-wire rather than a re-derivation.
 */
import type { ReceiptRow } from '../../lib/queries';
import { STABLE_SYMBOLS, ETH_SYMBOLS, formatUsdMagnitude } from '../TradesTable';

// A token independently anchors to USD when it's a stablecoin (≈ $1) or ETH/WETH
// (priced via the benchmark mid). Tier-independent — it says the pair *has* a USD
// tie-point, not that any particular mid is trustworthy.
export function isAnchorable(symbol: string): boolean {
	return STABLE_SYMBOLS.has(symbol) || ETH_SYMBOLS.has(symbol);
}

/**
 * For an ETH/WETH-quoted pair (one leg is WETH/native ETH, neither leg a
 * stablecoin), the stored realizedPrice/marketMid are ETH-per-base, not USD.
 * Re-express the price rows in USD-per-base from stored fields. Returns null for
 * stablecoin-quoted or unpriceable receipts (caller keeps the existing path).
 */
export function usdPerBasePrices(row: Pick<ReceiptRow,
	'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' |
	'realizedPrice' | 'marketMid' | 'notionalUsd'>
): { execUsd: number; marketUsd: number | null } | null {
	const inSym = row.inputSymbol;
	const outSym = row.outputSymbol;
	if (STABLE_SYMBOLS.has(inSym) || STABLE_SYMBOLS.has(outSym)) return null; // stable-quoted → already USD
	const inIsEth = ETH_SYMBOLS.has(inSym);
	const outIsEth = ETH_SYMBOLS.has(outSym);
	if (inIsEth === outIsEth) return null; // need exactly one ETH leg; the OTHER is base
	const baseAmount = Number(inIsEth ? row.outputAmount : row.inputAmount);
	const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
	const rp = row.realizedPrice == null ? null : Number(row.realizedPrice);
	const mm = row.marketMid == null ? null : Number(row.marketMid);
	if (notional == null || !Number.isFinite(notional) || !(baseAmount > 0)) return null;
	const execUsd = notional / baseAmount;
	const marketUsd =
		rp != null && mm != null && Number.isFinite(rp) && Number.isFinite(mm) && rp !== 0
			? execUsd * (mm / rp)
			: null;
	return { execUsd, marketUsd };
}

// A side's USD price marked at the benchmark mid: stablecoins are $1; for a
// stable↔ether pair the ether always sorts as `base`, so `marketMid` is the
// quote(≈USD)-per-ether price. Non-anchorable tokens have no defensible price.
function usdPriceAtMid(symbol: string, marketMid: number | null): number | null {
	if (STABLE_SYMBOLS.has(symbol)) return 1;
	if (ETH_SYMBOLS.has(symbol)) return marketMid;
	return null;
}

/**
 * Per-side USD notionals under the Phase-1 both-or-none rule: return a value for
 * each side only when BOTH sides can be independently valued at the mid (i.e. the
 * pair is double-anchored and the mid exists). Single- and no-anchor pairs return
 * both-null — we never show one notional and drop the other.
 */
export function perSideNotionals(
	row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'marketMid'>,
): { notionalIn: number | null; notionalOut: number | null } {
	const mid = row.marketMid == null ? null : Number(row.marketMid);
	const inUsd = usdPriceAtMid(row.inputSymbol, mid);
	const outUsd = usdPriceAtMid(row.outputSymbol, mid);
	if (inUsd == null || outUsd == null || !Number.isFinite(inUsd) || !Number.isFinite(outUsd)) {
		return { notionalIn: null, notionalOut: null };
	}
	return {
		notionalIn: Number(row.inputAmount) * inUsd,
		notionalOut: Number(row.outputAmount) * outUsd,
	};
}

/**
 * Per-side notionals for a SINGLE-anchor pair whose mid is validated (Phase 2a+).
 * The anchored side keeps its stored USD value (`notionalUsd`); the non-anchored
 * side — always the `base` (lower anchor rank) — is marked at the benchmark mid.
 * Returns null unless exactly one side anchors and a mid is available.
 */
export function singleAnchorNotionals(
	row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'notionalUsd' | 'marketMid' | 'realizedPrice' | 'anchorPriceUsd'>,
): { notionalIn: number; notionalOut: number; independent: boolean } | null {
	const inAnchor = isAnchorable(row.inputSymbol);
	const outAnchor = isAnchorable(row.outputSymbol);
	if (inAnchor === outAnchor) return null; // need exactly one anchored side
	const notionalUsd = row.notionalUsd == null ? null : Number(row.notionalUsd);
	if (notionalUsd == null || !Number.isFinite(notionalUsd)) return null;
	// Prefer the non-anchored side's OWN independent oracle price (a true second
	// valuation, e.g. WBTC via BTC/USD); else mark it at the benchmark mid
	// (USD-per-base for ETH-quoted pairs, else the stable-quoted mid is USD-per-base).
	const oracle = row.anchorPriceUsd == null ? null : Number(row.anchorPriceUsd);
	const independent = oracle != null && Number.isFinite(oracle) && oracle > 0;
	const usdP = usdPerBasePrices(row);
	const midPrice = usdP ? usdP.marketUsd : row.marketMid == null ? null : Number(row.marketMid);
	const basePrice = independent ? oracle : midPrice;
	if (basePrice == null || !Number.isFinite(basePrice)) return null;
	const baseIsOutput = !outAnchor; // the non-anchored side is the base
	const baseNotional = Number(baseIsOutput ? row.outputAmount : row.inputAmount) * basePrice;
	if (!Number.isFinite(baseNotional)) return null;
	return baseIsOutput
		? { notionalIn: notionalUsd, notionalOut: baseNotional, independent }
		: { notionalIn: baseNotional, notionalOut: notionalUsd, independent };
}

// Signed dollar execution result (notionalOut − notionalIn). Positive = surplus,
// shown green (matching formatDialogBps); negative keeps default color; both carry
// an explicit sign so a loss is unambiguous.
export function formatExecutionResult(gap: number): { text: string; color: string | undefined } {
	const mag = formatUsdMagnitude(gap) ?? '0.00';
	if (gap > 0) return { text: `+$${mag}`, color: '#117d45' };
	if (gap < 0) return { text: `-$${mag}`, color: undefined };
	return { text: '$0.00', color: undefined };
}

/**
 * Output-token difference vs marking the input at the benchmark mid, for no-anchor
 * pairs where a USD Price Delta would be false precision. No-anchor pairs always
 * resolve `base = input`, so `marketMid` is output-per-input. Null without a mid.
 */
export function outputTokenDelta(
	row: Pick<ReceiptRow, 'inputAmount' | 'outputAmount' | 'marketMid' | 'realizedPrice'>,
): number | null {
	if (row.marketMid == null || row.realizedPrice == null) return null;
	const mid = Number(row.marketMid);
	if (!Number.isFinite(mid)) return null;
	return Number(row.outputAmount) - Number(row.inputAmount) * mid;
}
```

- [ ] **Step 3: Move the tests**

Create `packages/dashboard/components/receipt/qualityNotionals.test.ts` containing the pure-helper describes moved verbatim from `ReceiptView.test.tsx`, with `./ReceiptView` rewritten to `./qualityNotionals`:

```ts
import { describe, expect, it } from 'vitest';

// Quarantined "was this a good trade" helpers — not wired into ReceiptView.
// See qualityNotionals.ts for why they are kept.

describe('per-side notionals (Phase 1: both-or-none)', () => {
	it('isAnchorable is true for stablecoins and ETH/WETH, false otherwise', async () => {
		const { isAnchorable } = await import('./qualityNotionals');
		expect(isAnchorable('USDC')).toBe(true);
		expect(isAnchorable('DAI')).toBe(true);
		expect(isAnchorable('WETH')).toBe(true);
		expect(isAnchorable('ETH')).toBe(true);
		expect(isAnchorable('WBTC')).toBe(false);
		expect(isAnchorable('GITLAWB')).toBe(false);
	});

	it('values both sides at their mid USD price for a double-anchored pair', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		// USDC->WETH, mid 2000 USDC/WETH; received 0.51 WETH for 1000 USDC (beat mid).
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.51', marketMid: '2000',
		} as never);
		expect(n.notionalIn).toBe(1000);   // 1000 USDC x $1
		expect(n.notionalOut).toBe(1020);  // 0.51 WETH x 2000
	});

	it('returns both-null for a single-anchored pair (no second anchor in Phase 1)', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		// ETH->WBTC: WBTC not anchorable -> both null (never split)
		const n = perSideNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.028', marketMid: '35',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null for a no-anchor pair', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		const n = perSideNotionals({
			inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
			inputAmount: '6745937.5', outputAmount: '7234145.96', marketMid: '1.1016',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null when an ether side has no mid to value it', async () => {
		const { perSideNotionals } = await import('./qualityNotionals');
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.5', marketMid: null,
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});
});

describe('formatExecutionResult', () => {
	it('formats a positive result as +$ in green', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(20)).toEqual({ text: '+$20.00', color: '#117d45' });
	});
	it('formats a negative result as -$ with default color', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(-10)).toEqual({ text: '-$10.00', color: undefined });
	});
	it('formats an exact-zero result as $0.00', async () => {
		const { formatExecutionResult } = await import('./qualityNotionals');
		expect(formatExecutionResult(0)).toEqual({ text: '$0.00', color: undefined });
	});
});

describe('outputTokenDelta (no-anchor Price Delta)', () => {
	it('is the output-token difference vs marking at mid', async () => {
		const { outputTokenDelta } = await import('./qualityNotionals');
		// 7,234,145.96 - 6,745,937.5 x 1.1016 = -197,178.79
		const d = outputTokenDelta({
			inputAmount: '6745937.5', outputAmount: '7234145.96',
			marketMid: '1.1016', realizedPrice: '1.0724',
		} as never);
		expect(d).toBeCloseTo(-197178.79, 1);
	});
	it('is null when there is no mid', async () => {
		const { outputTokenDelta } = await import('./qualityNotionals');
		expect(outputTokenDelta({ inputAmount: '1', outputAmount: '2', marketMid: null, realizedPrice: null } as never)).toBeNull();
	});
});

describe('singleAnchorNotionals (Phase 2a)', () => {
	it('values the non-anchored side at mid for an ETH-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		// ETH->WBTC (real row): ETH anchored, WBTC marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
			marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(1791.14, 1);  // ETH = stored notional
		expect(n?.notionalOut).toBeCloseTo(1795.71, 1); // WBTC valued at mid
	});

	it('values the non-anchored side at mid for a stable-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		// CLAWD->USDC: USDC anchored (output face), CLAWD marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'CLAWD', outputSymbol: 'USDC',
			inputAmount: '1000', outputAmount: '50', notionalUsd: '50',
			marketMid: '0.052', realizedPrice: '0.05',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(52, 6);   // 1000 CLAWD x 0.052
		expect(n?.notionalOut).toBeCloseTo(50, 6);  // USDC face
	});

	it('returns null for double-anchor and no-anchor pairs', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		expect(singleAnchorNotionals({ inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '2000', realizedPrice: '2000' } as never)).toBeNull();
		expect(singleAnchorNotionals({ inputSymbol: 'LFI', outputSymbol: 'GITLAWB', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '1', realizedPrice: '1' } as never)).toBeNull();
	});
});

describe('independent oracle anchor (Phase 2 WBTC)', () => {
	it('values the non-anchored side at anchorPriceUsd when present (independent, any tier)', async () => {
		const { singleAnchorNotionals } = await import('./qualityNotionals');
		const n = singleAnchorNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
			marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
			anchorPriceUsd: '62000',
		} as never);
		expect(n?.independent).toBe(true);
		expect(n?.notionalIn).toBeCloseTo(1791.14, 1);
		expect(n?.notionalOut).toBeCloseTo(0.02862539 * 62000, 4); // 1774.77
	});
});
```

- [ ] **Step 4: Run the new test file to verify it passes**

Run: `npx vitest run packages/dashboard/components/receipt/qualityNotionals.test.ts`
Expected: all PASS.

- [ ] **Step 5: Remove the helpers from `ReceiptView.tsx`**

Delete from `ReceiptView.tsx`:
- `const ETH_SYMBOLS = new Set(['WETH', 'ETH']);` (`:85`)
- `usdPerBasePrices` (`:105-132`)
- `isAnchorable` (`:134-139`)
- `usdPriceAtMid` (`:141-148`)
- `perSideNotionals` (`:150-169`)
- `singleAnchorNotionals` (`:171-200`)
- `formatExecutionResult` (`:202-210`)
- `outputTokenDelta` (`:212-224`)

Update the `./TradesTable` import to take `ETH_SYMBOLS` and drop the helpers' dependencies:

```tsx
import {
	formatDialogBps,
	formatExecutionPrice,
	formatPriceMagnitude,
	formatSubvalueUsd,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	legPairContext,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
	ShareButton,
	STABLE_SYMBOLS,
	ETH_SYMBOLS,
} from './TradesTable';
```

`symbolAnchorRank` (`:90-94`) **stays** and now reads `ETH_SYMBOLS` from the import.

- [ ] **Step 6: Remove the moved describes from `ReceiptView.test.tsx`**

Delete these five describes in full — they now live in `qualityNotionals.test.ts`:

- `describe('per-side notionals (Phase 1: both-or-none)', ...)`
- `describe('formatExecutionResult', ...)`
- `describe('outputTokenDelta (no-anchor Price Delta)', ...)`
- `describe('singleAnchorNotionals (Phase 2a)', ...)`
- `describe('independent oracle anchor (Phase 2 WBTC)', ...)` (only its one surviving test remains by now)

Also delete `describe('Receipt notional display (Phase 1)', ...)`, now reduced to the single `single-anchor: no per-side notionals and no Execution Result` test — it is fully subsumed by `Receipt makes no fair-value claim (MVP thesis)` from Task 3.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: all PASS — `packages/core` 186, dashboard green including `qualityNotionals.test.ts`.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --build`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/components/receipt packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx packages/dashboard/components/TradesTable.tsx
git commit -m "refactor(dashboard): quarantine the 'good trade' notional helpers

Move perSideNotionals, singleAnchorNotionals, formatExecutionResult,
isAnchorable, usdPerBasePrices and outputTokenDelta out of ReceiptView
into receipt/qualityNotionals.ts, unimported by the component but with
their tests still running. The work is valuable for the deferred
'was this a good trade' phase; keeping the tests green keeps it provably
alive rather than rotting behind a comment.

ETH_SYMBOLS moves to TradesTable beside STABLE_SYMBOLS so the quarantined
module doesn't have to import a client component.

Core is untouched: validateMid, tokenOracle and anchor_price_usd keep
forward-populating, so that phase resumes as a re-wire."
```

---

## Final verification

- [ ] **Full suite:** `npx vitest run` — core 186 pass; dashboard passes including live-DB tests.
- [ ] **Typecheck:** `npx tsc --build` — clean.
- [ ] **End-to-end against the real row.** Start the dashboard (`npm run dev`, port 3002) and open the receipt for `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f`. Confirm against Figma `365:2911`:

| Row | Expected |
|---|---|
| Size | `$1,791.14` |
| Token In | `1 ETH` |
| Token Out | `0.028625 WBTC` |
| Execution Price | `34.934 ETH = 1 WBTC` |
| Market Price | `35.0232 ETH = 1 WBTC`, label dotted, "not oracle-validated" tooltip |
| Price Delta | `0.0891927 ETH`, value dotted, tooltip *"WBTC was bought at better than Market Price"* |
| Gas Cost | `$0.0080` |
| Total Execution Quality | `+25.53bps` |

  Also confirm: no `Execution Result` row; no USD sub-values under Token In / Token Out / Execution Price / Market Price; dotted dividers above Size, above Execution Price, and above Gas Cost.

- [ ] **The headline check:** Price Delta's tooltip says **better** and Total Execution Quality is **positive**. Those two agreeing on the same receipt is the entire point of this change — before it, they contradicted each other.

> Note: Price Delta reads `0.0891927 ETH`, not Figma's `0.0892 ETH`. That is intended (see Global Constraints) — Figma subtracted the two rounded rows by hand.

- [ ] **Do not run `npm run lint`** — broken repo-wide, pre-existing.

## Out of scope

- Venue basis / fair-value reconciliation (the ~28bps pool-vs-BTC gap).
- Re-referencing the cost decomposition against an oracle — LP fee, aggregator fee, price impact and slippage are pool-relative by definition.
- General `mid_validated` corroborators (TWAP / cross-pool / DefiLlama) and additional token oracles (cbBTC, EURC).
- Address-based anchoring.
