# Token & Price Value Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render sub-cent USD prices with real precision, cap headline token amounts at 6 decimals, and give the Price Delta comparison label a tooltip — so memecoin values stop diminishing headline-token display.

**Architecture:** One shared `formatUsdMagnitude` helper centralizes the sub-cent (6-significant-figure) rule and feeds both `formatSubvalueUsd` (TradesTable) and `formatDelta` (ReceiptView). Token amount formatting keys off a derived per-unit USD price (`notionalUsd ÷ amount`). The Price Delta row gains a subvalue tooltip via a small `DetailRow` extension.

**Tech Stack:** TypeScript, React (Next.js), vitest + `renderToStaticMarkup`. No new dependencies.

## Global Constraints

- Sub-cent USD format: `0 < |value| < 0.01` → `toLocaleString('en-US', { maximumSignificantDigits: 6 })` (6 significant figures, trailing zeros auto-trimmed). `|value| >= 0.01` → existing 2-decimal form.
- Token amount format: whole part unlimited, **no thousands separators** (`useGrouping: false`); headline / unknown-price tokens cap decimals at **6**; sub-cent (<$0.01/unit) tokens cap at **18**; symbol never dropped.
- Per-unit USD price of a side = `notionalUsd ÷ amount`; boundary `>= 0.01` = headline (clamped). Unknown (missing/zero notional or amount) → clamped default.
- Sub-cent tokenOut never renders "At Market": `exec>mid → Below`, `exec<mid → Above`, exact tie → **Below Market**.
- Price Delta tooltip copy (verbatim): Below → `Execution Price is better than Market Price by $X`; Above → `Execution Price is worse than Market Price by $X`; At → `Execution Price is the same as Market Price within $0.01`.
- All commands run from `packages/dashboard`. Test runner: `npx vitest run <file>`.
- Out of scope (do NOT change): `formatExecutionPrice` main rate string, `formatDialogBps`, stored data, cost model.

---

### Task 1: Sub-cent USD magnitude helper + `formatSubvalueUsd`

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx:313-316` (`formatSubvalueUsd`)
- Test: `packages/dashboard/components/TradesTable.test.tsx`

**Interfaces:**
- Produces: `formatUsdMagnitude(value: number): string | null` — numeric string WITHOUT `$`, or `null` for zero/non-finite. `formatSubvalueUsd(value: number): string` — unchanged signature, now sub-cent-aware.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/components/TradesTable.test.tsx` (top level, after imports):

```tsx
describe('formatSubvalueUsd sub-cent precision', () => {
	it('renders a sub-cent value at 6 significant figures', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(0.000000667735)).toBe('$0.000000667735');
	});

	it('keeps 2-decimal formatting at or above $0.01', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(1829.76)).toBe('$1,829.76');
		expect(formatSubvalueUsd(2.25)).toBe('$2.25');
		expect(formatSubvalueUsd(0.01)).toBe('$0.01');
	});

	it('returns – for zero and non-finite', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(0)).toBe('–');
		expect(formatSubvalueUsd(NaN)).toBe('–');
	});

	it('formatUsdMagnitude returns unsigned string or null', async () => {
		const { formatUsdMagnitude } = await import('./TradesTable');
		expect(formatUsdMagnitude(0.000000667735)).toBe('0.000000667735');
		expect(formatUsdMagnitude(2.25)).toBe('2.25');
		expect(formatUsdMagnitude(0)).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/TradesTable.test.tsx -t "sub-cent precision"`
Expected: FAIL — `formatUsdMagnitude` is not exported; `formatSubvalueUsd(0.000000667735)` returns `$0.00`.

- [ ] **Step 3: Implement**

Replace `packages/dashboard/components/TradesTable.tsx:313-316`:

```tsx
export function formatSubvalueUsd(value: number): string {
	const mag = formatUsdMagnitude(value);
	return mag == null ? '–' : `$${mag}`;
}

// USD magnitude without the leading '$'. Sub-cent values (0 < |v| < 0.01) get
// 6 significant figures so memecoin unit prices and dust notionals don't round
// to $0.00; everything else keeps the 2-decimal grouped form. Returns null for
// zero / non-finite so callers choose their own placeholder.
export function formatUsdMagnitude(value: number): string | null {
	if (!Number.isFinite(value) || value === 0) return null;
	if (Math.abs(value) < 0.01) {
		return value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
	}
	return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/TradesTable.test.tsx -t "sub-cent precision"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full TradesTable suite (no regressions)**

Run: `npx vitest run components/TradesTable.test.tsx`
Expected: PASS (all existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx
git commit -m "feat(dashboard): sub-cent USD precision via formatUsdMagnitude"
```

---

### Task 2: `formatDelta` sub-cent precision

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx:1-33` (import + `formatDelta`)
- Test: `packages/dashboard/components/ReceiptView.test.tsx:11-28`

**Interfaces:**
- Consumes: `formatUsdMagnitude` from `./TradesTable` (Task 1).
- Produces: `formatDelta(marketMid, realizedPrice): string` — unchanged signature; sub-cent deltas now precise, exact-zero delta still `$0.00`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('formatDelta', …)` block in `packages/dashboard/components/ReceiptView.test.tsx` (after line 27, before the closing `});` at line 28):

```tsx
	it('renders a sub-cent delta at 6 significant figures', async () => {
		const { formatDelta } = await import('./ReceiptView');
		// Figma tooltip example: delta of $0.000000004856
		expect(formatDelta(0.000000004856, 0)).toBe('$0.000000004856');
	});

	it('renders an exact-zero delta as $0.00', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(1829.0, 1829.0)).toBe('$0.00');
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/ReceiptView.test.tsx -t "formatDelta"`
Expected: FAIL — sub-cent delta returns `$0.00` instead of `$0.000000004856`.

- [ ] **Step 3: Implement**

In `packages/dashboard/components/ReceiptView.tsx`, add `formatUsdMagnitude` to the existing import from `./TradesTable` (the import block at the top of the file that already pulls `formatSubvalueUsd`, `formatExecutionPrice`, etc.):

```tsx
	formatSubvalueUsd,
	formatUsdMagnitude,
```

Then replace the body of `formatDelta` at `packages/dashboard/components/ReceiptView.tsx:29-32`. Current:

```tsx
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	return `$${Math.abs(mid - exec).toFixed(2)}`;
}
```

New:

```tsx
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	// Sub-cent deltas keep precision; an exact-zero delta still reads $0.00.
	return `$${formatUsdMagnitude(Math.abs(mid - exec)) ?? '0.00'}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/ReceiptView.test.tsx -t "formatDelta"`
Expected: PASS — including the pre-existing `$0.68`, `$1.00`, `–` cases (all `>= $0.01` or invalid, unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): sub-cent precision for Price Delta magnitude"
```

---

### Task 3: Token amount decimal clamp + per-unit price helper

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx:583-589` (`formatTokenIn`/`formatTokenOut`)
- Modify: `packages/dashboard/components/TradesTable.tsx:709-711` (add `formatTokenAmount`, `tokenUnitPriceUsd` near `trimNumber`)
- Test: `packages/dashboard/components/TradesTable.test.tsx`

**Interfaces:**
- Produces: `tokenUnitPriceUsd(notionalUsd, amount): number | null`. `formatTokenIn(row)` / `formatTokenOut(row)` now accept an optional `notionalUsd` field on `row`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/components/TradesTable.test.tsx` (top level):

```tsx
describe('token amount decimal clamp', () => {
	it('caps headline (>$0.01/unit) token decimals at 6, no separators', async () => {
		const { formatTokenOut } = await import('./TradesTable');
		// unit price = 3.7 / 0.00122969043150473 ≈ $3009/unit → headline → cap at 6 decimals
		expect(
			formatTokenOut({ outputSymbol: 'WETH', outputAmount: '0.00122969043150473', notionalUsd: '3.7' }),
		).toBe('0.00123 WETH');
	});

	it('leaves large whole numbers intact without separators', async () => {
		const { formatTokenIn } = await import('./TradesTable');
		expect(
			formatTokenIn({ inputSymbol: 'USDC', inputAmount: '1000000000.123456789', notionalUsd: '1000000000' }),
		).toBe('1000000000.123457 USDC');
	});

	it('does not clamp sub-cent (<$0.01/unit) token decimals', async () => {
		const { formatTokenOut } = await import('./TradesTable');
		// unit price = 2.25 / 3369822.1456789 ≈ $6.7e-7 → sub-cent → keep precision
		expect(
			formatTokenOut({ outputSymbol: 'PEPE', outputAmount: '3369822.1456789', notionalUsd: '2.25' }),
		).toBe('3369822.1456789 PEPE');
	});

	it('defaults to clamped (6 decimals) when unit price is unknown', async () => {
		const { formatTokenIn } = await import('./TradesTable');
		expect(
			formatTokenIn({ inputSymbol: 'WETH', inputAmount: '0.123456789012' }),
		).toBe('0.123457 WETH');
	});

	it('tokenUnitPriceUsd returns null on missing/zero inputs', async () => {
		const { tokenUnitPriceUsd } = await import('./TradesTable');
		expect(tokenUnitPriceUsd('2.25', '3369822')).toBeCloseTo(2.25 / 3369822, 15);
		expect(tokenUnitPriceUsd(null, '10')).toBeNull();
		expect(tokenUnitPriceUsd('2.25', '0')).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/TradesTable.test.tsx -t "decimal clamp"`
Expected: FAIL — `tokenUnitPriceUsd` not exported; `formatTokenOut` ignores `notionalUsd` and uses the old 15-decimal `trimNumber`.

- [ ] **Step 3: Implement the helpers**

In `packages/dashboard/components/TradesTable.tsx`, immediately after `trimNumber` (currently lines 709-711):

```tsx
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

// Whole part unlimited (no separators); decimals capped at 6 for headline /
// unknown-price tokens and 18 for sub-cent (<$0.01/unit) tokens. Trailing zeros
// are trimmed by omitting minimumFractionDigits.
function formatTokenAmount(amount: string | number, unitPriceUsd: number | null): string {
	const n = Number(amount);
	if (!Number.isFinite(n)) return String(amount);
	const subCent = unitPriceUsd != null && unitPriceUsd < 0.01;
	return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: subCent ? 18 : 6 });
}
```

- [ ] **Step 4: Update `formatTokenIn`/`formatTokenOut`**

Replace `packages/dashboard/components/TradesTable.tsx:583-589`:

```tsx
export function formatTokenIn(row: { inputSymbol: string; inputAmount: string | number; notionalUsd?: string | number | null }): string {
	return `${formatTokenAmount(row.inputAmount, tokenUnitPriceUsd(row.notionalUsd, row.inputAmount))} ${row.inputSymbol}`;
}

export function formatTokenOut(row: { outputSymbol: string; outputAmount: string | number; notionalUsd?: string | number | null }): string {
	return `${formatTokenAmount(row.outputAmount, tokenUnitPriceUsd(row.notionalUsd, row.outputAmount))} ${row.outputSymbol}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run components/TradesTable.test.tsx -t "decimal clamp"`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full TradesTable + ReceiptView suites**

Run: `npx vitest run components/TradesTable.test.tsx components/ReceiptView.test.tsx`
Expected: PASS. (The ReceiptView `'1000 USDC'` / `'0.33 WETH'` render assertions still hold — `sampleReceiptRow`/`fullUsdcWethRow` carry `notionalUsd`, both sides price >$0.01, no separators.)

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx
git commit -m "feat(dashboard): clamp headline token amounts to 6 decimals, keep memecoin precision"
```

---

### Task 4: `priceDeltaComparison` sub-cent tokenOut rule

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx:34-41` (`priceDeltaComparison`)
- Test: `packages/dashboard/components/ReceiptView.test.tsx:30-51`

**Interfaces:**
- Produces: `priceDeltaComparison(marketMid, realizedPrice, tokenOutSubCent = false): string | undefined`. Third arg optional; 2-arg callers unchanged.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('priceDeltaComparison', …)` block in `packages/dashboard/components/ReceiptView.test.tsx` (before its closing `});` at line 51):

```tsx
	it('never returns At Market for a sub-cent tokenOut', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		// Within the 0.01 band but sub-cent tokenOut → resolve by sign, not "At Market".
		expect(priceDeltaComparison(0.0000010, 0.0000011, true)).toBe('Below Market');
		expect(priceDeltaComparison(0.0000011, 0.0000010, true)).toBe('Above Market');
	});

	it('breaks an exact sub-cent tie toward Below Market', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(0.0000010, 0.0000010, true)).toBe('Below Market');
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/ReceiptView.test.tsx -t "priceDeltaComparison"`
Expected: FAIL — 3-arg call ignores the flag; `0.0000010` vs `0.0000011` is within 0.01 → returns `At Market`.

- [ ] **Step 3: Implement**

Replace `packages/dashboard/components/ReceiptView.tsx:34-41`:

```tsx
export function priceDeltaComparison(
	marketMid: unknown,
	realizedPrice: unknown,
	tokenOutSubCent = false,
): string | undefined {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return undefined;
	if (tokenOutSubCent) {
		// The <$0.01 "At Market" band is meaningless when the whole price is
		// sub-cent; resolve by sign, and break an exact tie toward Below Market.
		if (exec > mid) return 'Below Market';
		if (exec < mid) return 'Above Market';
		return 'Below Market';
	}
	if (Math.abs(exec - mid) < 0.01) return 'At Market';
	if (exec > mid) return 'Below Market';
	return 'Above Market';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run components/ReceiptView.test.tsx -t "priceDeltaComparison"`
Expected: PASS — including the 4 pre-existing 2-arg cases (default `false`).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): sub-cent tokenOut never renders At Market"
```

---

### Task 5: Price Delta subvalue tooltip

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx:133-173` (`DetailRow` — add `subvalueTooltip`)
- Modify: `packages/dashboard/components/ReceiptView.tsx` import block (add `tokenUnitPriceUsd`)
- Modify: `packages/dashboard/components/ReceiptView.tsx:471-480` (Price Delta `DetailRow` + supporting locals)
- Test: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: `tokenUnitPriceUsd` (Task 3), `priceDeltaComparison` (Task 4), `formatDelta` (Task 2).
- Produces: `DetailRow` prop `subvalueTooltip?: string`; local `priceDeltaTooltip(comparison, deltaText): string`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/components/ReceiptView.test.tsx` (top level):

```tsx
describe('Price Delta tooltip', () => {
	const baseRow = {
		id: 7, chainId: 8453, pricingStatus: 'full',
		txHash: '0x1234567890abcdef1234567890abcdef12345678',
		blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
		inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1000.00', outputAmount: '0.33',
		notionalUsd: '1000.00', lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2',
		executionBps: '-1', gasCostUsd: '0.001', hopCount: 1, routeShape: 'single',
		decompConfidence: 'low', routeLegs: [], routePure: true, reconResidualBps: null,
	};

	it('renders the "better than Market" tooltip when below market', async () => {
		const { Receipt } = await import('./ReceiptView');
		// realized 3005 vs market 3000 → exec>mid → Below Market → "better"
		const html = renderToStaticMarkup(
			<Receipt row={{ ...baseRow, marketMid: '3000', realizedPrice: '3005' } as never} />,
		);
		expect(html).toContain('Execution Price is better than Market Price by $');
		// dotted-underline treatment on the subvalue label
		expect(html).toContain('decoration-dotted');
	});

	it('renders the "same as Market" tooltip when at market', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...baseRow, marketMid: '3000', realizedPrice: '3000' } as never} />,
		);
		expect(html).toContain('Execution Price is the same as Market Price within $0.01');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run components/ReceiptView.test.tsx -t "Price Delta tooltip"`
Expected: FAIL — no tooltip string is rendered for the Price Delta subvalue.

- [ ] **Step 3: Add `subvalueTooltip` to `DetailRow`**

In `packages/dashboard/components/ReceiptView.tsx`, add the prop to the `DetailRow` signature (the props object at lines 133-143) — add after `tooltip`:

```tsx
	subvalueTooltip,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	subvalue?: string | undefined;
	tooltip?: string;
	subvalueTooltip?: string;
}) {
```

Then replace the subvalue branch at lines 163-170:

```tsx
			{subvalue != null ? (
				<div className="flex flex-col gap-[10px] items-end min-w-0">
					<span>{children}</span>
					{subvalueTooltip ? (
						<span className="group relative cursor-default text-[var(--color-secondary)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
							{subvalue}
							<div
								role="tooltip"
								className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
							>
								{subvalueTooltip}
							</div>
						</span>
					) : (
						<span className="text-[var(--color-secondary)]">{subvalue}</span>
					)}
				</div>
			) : (
				<span className="min-w-0 text-right">{children}</span>
			)}
```

- [ ] **Step 4: Add `tokenUnitPriceUsd` to the import block**

In the `import { … } from './TradesTable';` block at the top of `ReceiptView.tsx`, add:

```tsx
	tokenUnitPriceUsd,
```

- [ ] **Step 5: Add the `priceDeltaTooltip` helper**

In `packages/dashboard/components/ReceiptView.tsx`, immediately after the `priceDeltaComparison` function (after its closing brace, ~line 50):

```tsx
function priceDeltaTooltip(comparison: string, deltaText: string): string {
	if (comparison === 'Below Market') return `Execution Price is better than Market Price by ${deltaText}`;
	if (comparison === 'Above Market') return `Execution Price is worse than Market Price by ${deltaText}`;
	return 'Execution Price is the same as Market Price within $0.01';
}
```

- [ ] **Step 6: Wire the Price Delta row**

In `Receipt()`, just after the `const notionalSubvalue = …` line (~line 371), add:

```tsx
	const tokenOutSubCent = (tokenUnitPriceUsd(row.notionalUsd, row.outputAmount) ?? Infinity) < 0.01;
	const priceDeltaText = hasMarketPrice
		? usdPrices && usdPrices.marketUsd != null
			? formatDelta(usdPrices.marketUsd, usdPrices.execUsd)
			: formatDelta(row.marketMid, row.realizedPrice)
		: undefined;
	const priceComparison = hasMarketPrice
		? priceDeltaComparison(row.marketMid, row.realizedPrice, tokenOutSubCent)
		: undefined;
```

Then replace the Price Delta `DetailRow` at lines 471-480:

```tsx
				<DetailRow
					label="Price Delta"
					subvalue={priceComparison}
					{...(priceComparison && priceDeltaText
						? { subvalueTooltip: priceDeltaTooltip(priceComparison, priceDeltaText) }
						: {})}
				>
					{hasMarketPrice ? priceDeltaText : UNAVAILABLE}
				</DetailRow>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run components/ReceiptView.test.tsx -t "Price Delta tooltip"`
Expected: PASS (2 tests).

- [ ] **Step 8: Run the full ReceiptView suite**

Run: `npx vitest run components/ReceiptView.test.tsx`
Expected: PASS — including the existing parametrized `'renders Price Delta subvalue …'` cases (they assert the comparison word, still emitted as `subvalue`).

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): Price Delta comparison label gains dotted-underline tooltip"
```

---

### Task 6: Full-suite + typecheck verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: exit 0, no output.

- [ ] **Step 2: Full dashboard test suite**

Run: `npx vitest run`
Expected: PASS (all files; only the pre-existing `lib/queries.test.ts` skips remain skipped).

- [ ] **Step 3: Drive it in the app (spot-check)**

Start the dev server if not already running (`npm run dev`, port 3002), open a receipt for a swap involving a sub-cent token, and confirm: Execution/Market price subvalues show full sub-cent precision (not `$0.00`); the memecoin Token In/Out amount keeps precision while the headline side caps at 6 decimals; hovering the Price Delta label shows the correct better/worse/same tooltip. If no headless browser is available, note that in the report and rely on the render-level assertions from Tasks 1-5.

- [ ] **Step 4: Final commit (if any verification-driven fixups were needed)**

```bash
git add -A && git commit -m "test(dashboard): verify token value display changes"
```

(Skip if steps 1-2 were clean and no fixups were made.)
