# Market Price Descriptor Strings + Footnote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Market Price methodology descriptor with the 12 Figma-exact strings, make the two `ORACLE_DISAGREE + SINGLE_SOURCE` states representable in the reducer, and move the descriptor to a `*`-connoted footnote below the price rows.

**Architecture:** Core owns the descriptor: `computeMarketPrice` (marketPrice.ts) emits the flag set, and `methodologyFor` (pricing.ts) turns a `MarketPriceResult` into one of the spec strings; the result is persisted to `receipts.methodology`. The dashboard renders that stored string verbatim as a footnote — it never re-derives it from flags. A NULL-column fallback (`fallbackMethodology`) covers legacy rows until repopulation refreshes them.

**Tech Stack:** TypeScript, Vitest, React (SSR via `renderToStaticMarkup`), Drizzle/Postgres, Node ESM scripts.

## Global Constraints

- Descriptor strings must match the Figma spec table **verbatim** (see spec doc `docs/superpowers/specs/2026-07-23-market-price-descriptor-strings-design.md`, section 2). Copy them exactly — punctuation, capitalization, and spacing included.
- `direct` estimator class → the words "direct pool price"; `bridged` class → "WETH-derived price"; `oracle` class → "oracle reference".
- No change to mid computation, tier assignment, notionals, or any flag other than making `SINGLE_SOURCE` co-emit with `ORACLE_DISAGREE`.
- Core is compiled with `npx tsc --build` (never `next build`, which corrupts a live dev server's `.next`). Client components import core pure helpers from the `@fabric-tca/core/pure` leaf, not the barrel.
- Run vitest from the package dir (`packages/core`, `packages/dashboard`). RPC e2e tests skip silently without `TCA_RPC_URL`; the controller (not a subagent) runs the full suite with RPC at the end.

---

### Task 1: Reducer emits `SINGLE_SOURCE` alongside `ORACLE_DISAGREE`

**Files:**
- Modify: `packages/core/src/marketPrice.ts:77-79`
- Test: `packages/core/src/marketPrice.test.ts`

**Interfaces:**
- Consumes: `computeMarketPrice(estimators, tolBps?) => MarketPriceResult` (existing).
- Produces: unchanged signature. New behavior: `flags` contains `'SINGLE_SOURCE'` whenever exactly one liquidity class is present and the result is not corroborated — including when `'ORACLE_DISAGREE'` is also present.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/marketPrice.test.ts`, extend the existing `describe('computeMarketPrice', …)` block. First, tighten the existing "oracle disagrees beyond tol" test (currently lines 47-52) by adding a `SINGLE_SOURCE` assertion, and add two new cases after it:

```ts
  it('single pool + disagreeing oracle => estimated with BOTH flags', () => {
    const r = computeMarketPrice([direct(100), oracle(110)]);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).toContain('SINGLE_SOURCE');   // the fix: single liquidity source
    expect(r.corroboratedBy).toEqual(['direct']); // names the lone class for the descriptor
  });

  it('single bridged pool + disagreeing oracle => BOTH flags, bridged named', () => {
    const r = computeMarketPrice([bridged(100), oracle(110)]);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).toContain('SINGLE_SOURCE');
    expect(r.corroboratedBy).toEqual(['bridged']);
  });

  it('two liquidity classes + disagreeing oracle => NO SINGLE_SOURCE', () => {
    const r = computeMarketPrice([direct(100), bridged(100.3), oracle(140)]);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).not.toContain('SINGLE_SOURCE'); // >=2 classes: not single-source
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/marketPrice.test.ts`
Expected: FAIL — the two new "BOTH flags" cases fail because `flags` lacks `SINGLE_SOURCE` (the old `flags.length === 0` guard suppressed it).

- [ ] **Step 3: Apply the reducer fix**

In `packages/core/src/marketPrice.ts`, replace lines 77-79:

```ts
  const corroborated = liquidityCorroborated || oracleCorroborated;
  if (!corroborated && flags.length === 0) flags.push('SINGLE_SOURCE');
  return { tier: corroborated ? 'full' : 'estimated', marketMid, corroboratedBy, flags };
```

with:

```ts
  const corroborated = liquidityCorroborated || oracleCorroborated;
  // SINGLE_SOURCE = exactly one liquidity class present and uncorroborated. It can
  // co-occur with ORACLE_DISAGREE (a lone pool the oracle contradicts) but never with
  // LIQUIDITY_DISAGREE (that requires >=2 classes). Tier is already 'estimated' here.
  if (!corroborated && liqClasses.length === 1) flags.push('SINGLE_SOURCE');
  return { tier: corroborated ? 'full' : 'estimated', marketMid, corroboratedBy, flags };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/marketPrice.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "fix(core): SINGLE_SOURCE co-emits with ORACLE_DISAGREE for a lone pool"
```

---

### Task 2: Descriptor strings in `methodologyFor` + fast-path

**Files:**
- Modify: `packages/core/src/pricing.ts:329-338` (`methodologyFor`), `packages/core/src/pricing.ts:442` (fast-path string)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `MarketPriceResult { tier, marketMid, corroboratedBy: EstimatorClass[], flags: string[] }` from `./marketPrice.js`.
- Produces: `methodologyFor(mp: MarketPriceResult) => string` returning one of the spec strings. Same signature as today (internal, non-exported).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/pricing.test.ts`, update the `priceReceipt tier wiring` fixtures (lines 430-435) and their assertions, and add new cases. Replace the three fixtures with:

```ts
const fullMid = (price: number): MarketPriceResult =>
  ({ tier: 'full', marketMid: price, corroboratedBy: ['direct', 'bridged'], flags: [] });
const estMid = (price: number): MarketPriceResult =>
  ({ tier: 'estimated', marketMid: price, corroboratedBy: ['direct'], flags: ['SINGLE_SOURCE'] });
const noMid = (): MarketPriceResult =>
  ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'] });
```

Change the two methodology assertions:
- line 450 `expect(r.methodology.toLowerCase()).toContain('corroborat');`
  → `expect(r.methodology).toBe('Confirmed: The direct pool price and WETH-derived price agree.');`
- line 464 `expect(r.methodology.toLowerCase()).toContain('single');`
  → `expect(r.methodology).toBe('Estimated: Only the direct pool price was available.');`

Then add a focused unit `describe` block for the string mapping (place it right after the `priceReceipt tier wiring` describe). Import `methodologyFor` is not exported, so drive it through `priceReceipt` with injected `getMarketPrice`:

```ts
describe('methodology descriptor strings', () => {
  const run = async (mp: MarketPriceResult) => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({ getMarketPrice: async () => mp, getUsdValue: async () => 1800 }),
    );
    return r.methodology;
  };
  const mp = (tier: MarketPriceResult['tier'], corroboratedBy: MarketPriceResult['corroboratedBy'], flags: string[]): MarketPriceResult =>
    ({ tier, marketMid: 1800, corroboratedBy, flags });

  it('full: direct + bridged + oracle', async () =>
    expect(await run(mp('full', ['direct', 'bridged', 'oracle'], []))).toBe(
      'Confirmed: The direct pool price, WETH-derived price, and oracle reference agree.'));
  it('full: direct + oracle', async () =>
    expect(await run(mp('full', ['direct', 'oracle'], []))).toBe(
      'Confirmed: The direct pool price and oracle reference agree.'));
  it('full: bridged + oracle', async () =>
    expect(await run(mp('full', ['bridged', 'oracle'], []))).toBe(
      'Confirmed: The WETH-derived price and oracle reference agree.'));
  it('full: direct + bridged', async () =>
    expect(await run(mp('full', ['direct', 'bridged'], []))).toBe(
      'Confirmed: The direct pool price and WETH-derived price agree.'));
  it('estimated: single source direct', async () =>
    expect(await run(mp('estimated', ['direct'], ['SINGLE_SOURCE']))).toBe(
      'Estimated: Only the direct pool price was available.'));
  it('estimated: single source bridged', async () =>
    expect(await run(mp('estimated', ['bridged'], ['SINGLE_SOURCE']))).toBe(
      'Estimated: Only the WETH-derived price was available.'));
  it('estimated: liquidity disagree', async () =>
    expect(await run(mp('estimated', [], ['LIQUIDITY_DISAGREE']))).toBe(
      'Estimated: The direct pool price and WETH-derived price disagree. Showing their median.'));
  it('estimated: oracle disagree, single direct', async () =>
    expect(await run(mp('estimated', ['direct'], ['ORACLE_DISAGREE', 'SINGLE_SOURCE']))).toBe(
      'Estimated: The direct pool price and oracle reference disagree. Showing the direct pool price.'));
  it('estimated: oracle disagree, single bridged', async () =>
    expect(await run(mp('estimated', ['bridged'], ['ORACLE_DISAGREE', 'SINGLE_SOURCE']))).toBe(
      'Estimated: The WETH-derived price and oracle reference disagree. Showing the WETH-derived price.'));
  it('estimated: liquidity + oracle disagree', async () =>
    expect(await run(mp('estimated', [], ['LIQUIDITY_DISAGREE', 'ORACLE_DISAGREE']))).toBe(
      'Estimated: The direct pool price and WETH-derived price disagree, and the oracle reference does not confirm their median. Showing the median of the two pool-based prices.'));
  it('none', async () =>
    expect(await run(mp('none', [], ['NO_LIQUIDITY']))).toBe(
      'Unavailable: No reliable market price could be calculated.'));
});
```

Note: the `none` case routes through `priceReceipt`'s null-mid path (line 471), which still returns `methodology = methodologyFor(mp)`, so this asserts the string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/pricing.test.ts`
Expected: FAIL — current `methodologyFor` returns the old coarse strings ("Corroborated market price (…)", "Estimated: single uncorroborated pool mid…", "No reliable market price available.").

- [ ] **Step 3: Rewrite `methodologyFor` and the fast-path string**

In `packages/core/src/pricing.ts`, replace `methodologyFor` (lines 329-338):

```ts
/** Human-readable methodology string derived from a Market Price apparatus result. */
function methodologyFor(mp: MarketPriceResult): string {
  const CLASS_PHRASE: Record<EstimatorClass, string> = {
    direct: 'direct pool price',
    bridged: 'WETH-derived price',
    oracle: 'oracle reference',
  };

  if (mp.tier === 'none') return 'Unavailable: No reliable market price could be calculated.';

  if (mp.tier === 'full') {
    // Order the corroborators canonically (direct, bridged, oracle) and join them:
    // "The A and B agree." / "The A, B, and C agree." First phrase is capitalized.
    const order: EstimatorClass[] = ['direct', 'bridged', 'oracle'];
    const parts = order.filter((c) => mp.corroboratedBy.includes(c)).map((c) => CLASS_PHRASE[c]);
    const joined = parts.length === 3
      ? `${parts[0]}, ${parts[1]}, and ${parts[2]}`
      : parts.join(' and ');
    return `Confirmed: The ${joined} agree.`;
  }

  // estimated
  const liq = mp.corroboratedBy.includes('bridged') ? 'bridged' : 'direct';
  if (mp.flags.includes('LIQUIDITY_DISAGREE') && mp.flags.includes('ORACLE_DISAGREE')) {
    return 'Estimated: The direct pool price and WETH-derived price disagree, and the oracle reference does not confirm their median. Showing the median of the two pool-based prices.';
  }
  if (mp.flags.includes('LIQUIDITY_DISAGREE')) {
    return 'Estimated: The direct pool price and WETH-derived price disagree. Showing their median.';
  }
  if (mp.flags.includes('ORACLE_DISAGREE')) {
    return liq === 'bridged'
      ? 'Estimated: The WETH-derived price and oracle reference disagree. Showing the WETH-derived price.'
      : 'Estimated: The direct pool price and oracle reference disagree. Showing the direct pool price.';
  }
  return liq === 'bridged'
    ? 'Estimated: Only the WETH-derived price was available.'
    : 'Estimated: Only the direct pool price was available.';
}
```

Add `EstimatorClass` to the existing `./marketPrice.js` import (pricing.ts lines 34-38). Change:

```ts
import {
  getMarketPriceForPair,
  type MarketPriceResult,
  type MarketPriceTier,
} from './marketPrice.js';
```

to:

```ts
import {
  getMarketPriceForPair,
  type MarketPriceResult,
  type MarketPriceTier,
  type EstimatorClass,
} from './marketPrice.js';
```

Then update the fast-path methodology string at line 442:

```ts
        methodology: 'Corroborated WETH/USD benchmark (median pools + oracle) at block N-1.',
```

to:

```ts
        methodology: 'Confirmed: The median of the available WETH/USDC pool prices agrees with the oracle reference.',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck core**

Run: `cd packages/core && npx tsc --build`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): Market Price descriptor emits the 12 spec-exact strings"
```

---

### Task 3: Dashboard fallback + `*` footnote layout

**Files:**
- Modify: `packages/dashboard/components/receipt/priceFormat.ts:98-102` (`fallbackMethodology`)
- Modify: `packages/dashboard/components/receiptView.tsx:201-226` (Market Price row + footnote)
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx:52-131` (remove dead `subLabel` prop)
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `methodologyText` (string, already computed at receiptView.tsx:85 as `row.methodology ?? fallbackMethodology(row.pricingStatus)`); `hasMarketPrice` (boolean, receiptView.tsx:81).
- Produces: no new exported symbols. `DetailRow` loses its `subLabel` prop.

- [ ] **Step 1: Update the failing tests**

In `packages/dashboard/components/receiptView.test.tsx`:

(a) Rewrite the `fallbackMethodology` test (lines 132-137):

```ts
	it('maps each pricing tier to its descriptor', async () => {
		const { fallbackMethodology } = await import('./receipt/priceFormat');
		expect(fallbackMethodology('full')).toContain('Confirmed:');
		expect(fallbackMethodology('estimated')).toContain('Estimated:');
		expect(fallbackMethodology('partial')).toBe('Unavailable: No reliable market price could be calculated.');
	});
```

(b) Rewrite the descriptor render test (lines 936-959) to assert the `*` footnote, the `Market Price*` label, and its absence on the null-mid state:

```ts
	it('renders the Market Price descriptor as a *-footnote when a mid exists', async () => {
		const { Receipt } = await import('./receiptView');
		// The stored methodology wins when present, rendered as a *-prefixed footnote.
		const stored = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, methodology: 'Confirmed: The direct pool price and WETH-derived price agree.' } as never} />,
		);
		expect(stored).toContain('*Confirmed: The direct pool price and WETH-derived price agree.');
		expect(stored).toContain('Market Price*'); // label carries the asterisk connotation

		// A NULL methodology falls back to the tier string, still as a footnote.
		const estimated = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, methodology: null } as never} />);
		expect(estimated).toContain('Estimated:');

		// The null-mid state shows NO asterisk and NO footnote (decision: only when a mid exists).
		const partial = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'partial', marketMid: null, methodology: null, allInCostBps: null } as never} />,
		);
		expect(partial).not.toContain('Market Price*');
		expect(partial).not.toContain('Unavailable: No reliable market price could be calculated.');

		// The hardcoded tooltip copy stays gone.
		for (const html of [stored, estimated]) {
			expect(html).not.toContain('cross-referenced against an on-chain price oracle');
			expect(html).not.toContain('Best-effort reference from the deepest on-chain pool');
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run components/receiptView.test.tsx`
Expected: FAIL — `Market Price*` and the `*`-prefixed footnote are not yet rendered; `fallbackMethodology` still returns old strings.

- [ ] **Step 3: Update `fallbackMethodology`**

In `packages/dashboard/components/receipt/priceFormat.ts`, replace the body (lines 98-102):

```ts
export function fallbackMethodology(pricingStatus: string): string {
	if (pricingStatus === 'full') return 'Confirmed: market price corroborated across sources.';
	if (pricingStatus === 'estimated') return 'Estimated: market price is uncorroborated.';
	return 'Unavailable: No reliable market price could be calculated.';
}
```

Also update its doc comment (lines 90-97) to drop the "Corroborated" wording — change "Mirrors core's `methodologyFor`" note's example if it names a specific old string. Minimal: leave the comment structure, just ensure it doesn't claim the strings are "richer" in a way that now misleads. (A one-line touch is fine; no behavior depends on the comment.)

- [ ] **Step 4: Move the descriptor to a footnote in `receiptView.tsx`**

In `packages/dashboard/components/receiptView.tsx`, change the Market Price `DetailRow` (lines 201-219): remove the `subLabel` line and make the label conditional. Replace:

```tsx
				<DetailRow
					label="Market Price"
					subLabel={methodologyText}
					subValue={marketUsdPerBase != null ? formatSubvalueUsd(marketUsdPerBase) : undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
```

with:

```tsx
				<DetailRow
					label={hasMarketPrice ? 'Market Price*' : 'Market Price'}
					subValue={marketUsdPerBase != null ? formatSubvalueUsd(marketUsdPerBase) : undefined}
					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
				>
```

Then add the footnote AFTER the Price Delta `DetailRow` (which ends at line 226 `</DetailRow>`) and BEFORE the `<Divider dashed />` at line 228:

```tsx
				</DetailRow>

				{hasMarketPrice && (
					<p className="text-[12px] leading-[18px] text-[var(--color-secondary)]">
						*{methodologyText}
					</p>
				)}

				<Divider dashed />
```

(The existing `<Divider dashed />` at line 228 stays; the footnote is inserted just above it.)

- [ ] **Step 5: Remove the now-dead `subLabel` prop from `DetailRow`**

In `packages/dashboard/components/receipt/receiptRows.tsx`, delete the `subLabel` prop from `DetailRow`: remove the doc-commented prop declaration (lines 68-69), the `subLabel,` destructure entry (line 59), and the full-width render block (lines 122-129):

```tsx
			{/* Full-width, single-line: the label column (180px) is too narrow for the
			    Market Price methodology descriptor, so this breaks out of the grid
			    instead of wrapping across 3+ lines. */}
			{subLabel != null && (
				<span className="whitespace-nowrap text-[12px] leading-[12px] text-[var(--color-secondary)]">
					{subLabel}
				</span>
			)}
```

After removal, the `DetailRow` return can collapse the outer wrapper if it no longer needs the `flex flex-col gap-[10px]` container (the container existed to stack the grid above the subLabel). Keep the outer `<div className="flex flex-col gap-[10px]">` only if other content still stacks under the grid; since only the grid remains, return the grid `<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">…</div>` directly. Verify no other JSX child depended on the wrapper.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/dashboard && npx vitest run components/receiptView.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck the dashboard**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: exit 0. (If `tsc --noEmit` is not the project's convention, run the repo's dashboard typecheck script; confirm no unused-var error for a leftover `subLabel`.)

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receipt/priceFormat.ts packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): Market Price descriptor moves to a *-footnote"
```

---

### Task 4: Full suite + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Build core so the dashboard consumes fresh dist**

Run: `cd packages/core && npx tsc --build`
Expected: exit 0.

- [ ] **Step 2: Run the core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS. (RPC e2e tests skip without `TCA_RPC_URL` — acceptable for a subagent; the controller re-runs with RPC in Task 5.)

- [ ] **Step 3: Run the dashboard suite**

Run: `cd packages/dashboard && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit (only if any incidental fix was needed)**

If steps 1-3 required a fix, commit it:

```bash
git add -A
git commit -m "test: green suite for Market Price descriptor change"
```

Otherwise skip — nothing to commit.

---

### Task 5 (CONTROLLER-ONLY, needs RPC): repopulate receipts

> Run by the controller, NOT a subagent — subagents lack `TCA_RPC_URL` and their RPC e2e tests silently skip. This task refreshes the DB `methodology` / `market_price_flags` columns; mids are unchanged.

- [ ] **Step 1: Confirm env is present**

Run: `test -n "$TCA_RPC_URL" && test -f .env && echo ok`
Expected: `ok` (the script reads `.env` itself, but confirm it exists).

- [ ] **Step 2: Dry-run the repopulation diff**

Run: `node scripts/repopulateReceipts.mjs`
Expected: a per-row diff printed; rows show changed `methodology` (new strings) and `market_price_flags` where a lone pool met a disagreeing oracle. No writes.

- [ ] **Step 3: Review the diff**

Confirm the changed `methodology` strings match the spec table and that no mid/tier changed unexpectedly (only descriptor text and, for lone-pool+oracle-disagree rows, the added `SINGLE_SOURCE` flag). If any row's tier or mid moved, STOP and investigate before committing.

- [ ] **Step 4: Commit the repopulation to the DB**

Run: `node scripts/repopulateReceipts.mjs --commit`
Expected: rows updated in place; ids / created_at / user_id preserved.

- [ ] **Step 5: Run the full core suite WITH RPC**

Run: `set -a && source .env && set +a && cd packages/core && npx vitest run`
Expected: PASS including the RPC e2e tests (e.g. BLUAI/WETH id 209, ETH/WBTC).

- [ ] **Step 6: Spot-check the receipt in the app**

Load a repopulated receipt (e.g. the ETH→WBTC WARP default) in the running dev server and confirm: `Market Price*` label, the `*`-prefixed footnote below Price Delta with the correct string, and no footnote on a null-mid receipt.

---

## Self-Review Notes

- **Spec coverage:** Task 1 = reducer flag fix (spec §1); Task 2 = 12 strings + fast-path (spec §2); Task 3 = fallback + footnote + `*` label + dead-prop removal (spec §3, decision "only when a mid exists"); Tasks 4-5 = tests + repopulation (spec §4-5). All spec sections mapped.
- **Decisions honored:** `*`/footnote render only when `hasMarketPrice` (Task 3 Steps 4-5); repopulation runs (Task 5).
- **Type consistency:** `EstimatorClass` and `MarketPriceResult` imported from `./marketPrice.js` in pricing.ts; `methodologyFor` signature unchanged; `fallbackMethodology(string)` unchanged; `DetailRow` loses `subLabel` (verified sole caller was the Market Price row).
- **Line numbers** are from the current tree and may drift as edits land within a file — match on the quoted code, not the line number.
