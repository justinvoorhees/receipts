# Error Tooltips Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. TDD, frequent commits.

**Goal:** Reformat the 5 receipt-error states from a DiagnosticCard into an inline red reason label under the search field (dotted underline static, solid on hover, dark tooltip above), per Figma; drop the relayer beneficiary detail and trim now-dead symbol resolution.

**Architecture:** New presentational `FailureNotice` (+ `REASON_COPY`) using the dotted→solid `group-hover` tooltip idiom already in `ReceiptView.tsx`. `ReceiptSearch` takes a `failure?: AnalyzeFailure` prop and renders it; `ReceiptView` drops the card and passes `failure` through. Core `classifyTransaction` stops resolving symbols.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind, Vitest (`renderToStaticMarkup`).

## Global Constraints

- Run tests from repo root: `npx vitest run <path>`. Typecheck: `npm run typecheck`.
- `@fabric-tca/core` resolves to source; no build step between tasks.
- Copy is verbatim (see Task 2 table). Native token sentinel `'native'`.
- Branch `feat/error-tooltips` already exists (we're on it).
- Commit after each task's tests pass.

---

### Task 1: Trim `classifyTransaction` symbol resolution + `RelayerDetail` symbol fields (core)

**Files:**
- Modify: `packages/core/src/classifyTransaction.ts`
- Modify: `packages/core/src/endpoints.ts`
- Test: `packages/core/src/classifyTransaction.test.ts` (existing; must stay green)

**Interfaces:**
- Produces: `RelayerDetail = { beneficiary: string; inputToken: string; outputToken: string }` (symbols removed); `classifyTransaction` unchanged signature, RELAYER branch returns `{ reason: 'RELAYER_THIRD_PARTY', detail }`.

- [ ] **Step 1: Drop symbol fields from `RelayerDetail`** in `packages/core/src/endpoints.ts` (currently lines 93-99):

```ts
export interface RelayerDetail {
	beneficiary: string;
	inputToken: string;
	outputToken: string;
}
```

- [ ] **Step 2: Remove the symbol-resolution block** in `packages/core/src/classifyTransaction.ts`. Replace lines ~68-90 (from `const detail =` through the RELAYER return) with:

```ts
		const detail = selectBeneficiary(candidates, trader, (a) => eoaFlags.get(a.toLowerCase()) ?? false);
		if (!detail) return { reason: 'NOT_DECODABLE' };
		return { reason: 'RELAYER_THIRD_PARTY', detail };
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}
}
```

Then remove the now-unused imports/consts at the top of the file: `import { createDefaultPricingDeps } from './pricing.js';`, the `type RelayerDetail` from the `./endpoints.js` import, and the `const NATIVE = 'native';` line **only if** `NATIVE` is no longer referenced (grep it first: `grep -n NATIVE packages/core/src/classifyTransaction.ts`).

- [ ] **Step 3: Run the classify tests + typecheck**

Run: `set -a; . ./.env; set +a && npx vitest run packages/core/src/classifyTransaction.test.ts`
Expected: PASS — including the gated e2e (beneficiary `0xf70da978…`, USDC→native). The test never asserted symbols, so no test change needed.

Run: `npm run typecheck`
Expected: clean (confirms no dangling `RelayerDetail.inputSymbol` references remain anywhere).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/classifyTransaction.ts packages/core/src/endpoints.ts
git commit -m "refactor(core): drop unused relayer symbol resolution from classifyTransaction"
```

---

### Task 2: `FailureNotice` component + `REASON_COPY`; delete `DiagnosticCard`

**Files:**
- Create: `packages/dashboard/components/FailureNotice.tsx`
- Create: `packages/dashboard/components/FailureNotice.test.tsx`
- Delete: `packages/dashboard/components/DiagnosticCard.tsx`, `packages/dashboard/components/DiagnosticCard.test.tsx`

**Interfaces:**
- Consumes: `AnalyzeFailure`, `FailureReason` from `@fabric-tca/core`.
- Produces: `REASON_COPY: Record<FailureReason, { label: string; tooltip: string | null }>`, `FailureNotice({ failure }: { failure: AnalyzeFailure }): JSX.Element`.

- [ ] **Step 1: Write the failing test** — `packages/dashboard/components/FailureNotice.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('FailureNotice', () => {
	it('renders a dotted-underline label + tooltip for a tooltip-bearing reason', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_DECODABLE' }} />);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Could not find a token-in / token-out swap');
		expect(html).toContain('decoration-dotted');
		expect(html).toContain('hover:decoration-solid');
	});

	it('renders a plain label (no underline, no tooltip) for NOT_FOUND_ONCHAIN', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);
		expect(html).toContain('Transaction not found on Base');
		expect(html).not.toContain('decoration-dotted');
	});

	it('shows the relayer generic tooltip and NO beneficiary detail', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(
			<FailureNotice
				failure={{
					reason: 'RELAYER_THIRD_PARTY',
					detail: { beneficiary: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', inputToken: '0x8335', outputToken: 'native' },
				}}
			/>,
		);
		expect(html).toContain('Relay / third-party trade');
		expect(html).toContain('Beneficiary-anchored decoding not yet supported');
		expect(html).not.toContain('0xf70d');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/components/FailureNotice.test.tsx`
Expected: FAIL — module `./FailureNotice` does not exist.

- [ ] **Step 3: Implement** `packages/dashboard/components/FailureNotice.tsx`:

```tsx
import type { AnalyzeFailure, FailureReason } from '@fabric-tca/core';

export const REASON_COPY: Record<FailureReason, { label: string; tooltip: string | null }> = {
	INVALID_HASH: {
		label: 'Invalid transaction hash',
		tooltip: 'Input does not look like a transaction hash, please try a 66-character 0x… value',
	},
	NOT_FOUND_ONCHAIN: {
		label: 'Transaction not found on Base',
		tooltip: null,
	},
	RELAYER_THIRD_PARTY: {
		label: 'Relay / third-party trade',
		tooltip: 'Sender relayed this swap on behalf of another address. Beneficiary-anchored decoding not yet supported',
	},
	NOT_DECODABLE: {
		label: 'Not a swap',
		tooltip: 'Could not find a token-in / token-out swap for this transaction (transfer, approval, LP action, etc)',
	},
	ANALYZE_ERROR: {
		label: 'Analysis failed, try again',
		tooltip: 'RPC error, unavailable trace, or other unexpected infrastructure error',
	},
};

/** Inline red reason label under the search field. Plain when tooltip is null;
 *  otherwise a dotted-underline (solid on hover) trigger with a dark tooltip above. */
export function FailureNotice({ failure }: { failure: AnalyzeFailure }) {
	const { label, tooltip } = REASON_COPY[failure.reason];

	if (!tooltip) {
		return (
			<span className="font-['Sohne_Breit'] text-[12px] leading-[12px]" style={{ color: 'var(--color-red)' }}>
				{label}
			</span>
		);
	}

	return (
		<span
			className="group relative w-fit cursor-default font-['Sohne_Breit'] text-[12px] leading-[12px] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
			style={{ color: 'var(--color-red)' }}
		>
			{label}
			<span className="pointer-events-none invisible absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] whitespace-normal rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] font-normal leading-[20px] text-[var(--color-surface-base)] no-underline group-hover:visible">
				{tooltip}
			</span>
		</span>
	);
}
```

- [ ] **Step 4: Delete the DiagnosticCard files**

```bash
git rm packages/dashboard/components/DiagnosticCard.tsx packages/dashboard/components/DiagnosticCard.test.tsx
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run packages/dashboard/components/FailureNotice.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/FailureNotice.tsx packages/dashboard/components/FailureNotice.test.tsx
git commit -m "feat(dashboard): FailureNotice inline error label + tooltip; remove DiagnosticCard"
```

---

### Task 3: Wire `ReceiptSearch` (failure prop) + `ReceiptView` (drop card)

**Files:**
- Modify: `packages/dashboard/components/ReceiptSearch.tsx`
- Modify: `packages/dashboard/components/ReceiptView.tsx:448-474` (+ remove import line 5)
- Test: `packages/dashboard/components/ReceiptView.test.tsx:440-454`

**Interfaces:**
- Consumes: `FailureNotice` (Task 2), `AnalyzeFailure` from `@fabric-tca/core`.
- Produces: `ReceiptSearch({ hash, failure }: { hash: string; failure?: AnalyzeFailure })`.

- [ ] **Step 1: Update the ReceiptView diagnosis tests** (`packages/dashboard/components/ReceiptView.test.tsx`, lines 440-454) to the new copy + no-card behavior:

```tsx
describe('ReceiptView diagnosis', () => {
	it('renders the failure notice when trade is null and a diagnosis is present', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={null} hash="0xabc" diagnosis={{ reason: 'NOT_DECODABLE' }} />,
		);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Could not find a token-in / token-out swap');
	});

	it('renders no failure notice when no diagnosis is supplied', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="0xabc" />);
		expect(html).not.toContain('Not a swap');
	});
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: FAIL — old ReceiptView renders the DiagnosticCard's "Not a decodable swap", not "Not a swap".

- [ ] **Step 3: Update `ReceiptView`** — remove the DiagnosticCard import (line 5) and replace the function body (lines 448-474):

```tsx
export function ReceiptView({
	trade,
	hash,
	diagnosis,
}: {
	trade: ReceiptRow | null;
	hash: string;
	diagnosis?: AnalyzeFailure;
}) {
	// Only surface a failure when there is no receipt to show.
	const failure = trade === null ? diagnosis : undefined;

	return (
		<div className="flex flex-col gap-[40px] pb-10">
			<ReceiptSearch hash={hash} {...(failure ? { failure } : {})} />
			{trade != null && <Receipt row={trade} />}
		</div>
	);
}
```

- [ ] **Step 4: Update `ReceiptSearch`** (`packages/dashboard/components/ReceiptSearch.tsx`):

Add imports near the top (after the existing imports):
```tsx
import type { AnalyzeFailure } from '@fabric-tca/core';
import { FailureNotice } from './FailureNotice';
```

Change the signature (line 6):
```tsx
export function ReceiptSearch({ hash, failure }: { hash: string; failure?: AnalyzeFailure }) {
```

Change the error flag (line 44):
```tsx
	const hasError = failure != null;
```

Replace the error span block (lines ~99-105) with:
```tsx
			{failure && <FailureNotice failure={failure} />}
```

(Leave the `borderColor`/`textColor`/`labelColor`/button-bg logic — they key off `hasError`, now driven by `failure != null`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx packages/dashboard/components/FailureNotice.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean (no remaining `error` prop / `DiagnosticCard` references).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/ReceiptSearch.tsx packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): render FailureNotice under the search field; drop DiagnosticCard wiring"
```

---

## Verification (after all tasks)

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run packages/core packages/dashboard/components` green (only the 3 pre-existing `queries.test.ts` DB flakes may fail, and those are in `packages/dashboard/lib`, not `components`).
- [ ] `grep -rn "DiagnosticCard" packages` returns nothing.
- [ ] Live (optional): `npm run dev`, paste a malformed hash → "Invalid transaction hash" with dotted underline + hover tooltip; a non-swap hash → "Not a swap"; the relayer hash (needs stopgap row 119 deleted) → "Relay / third-party trade" tooltip, no beneficiary text.

## Self-Review Notes
- Spec coverage: copy table (Task 2 `REASON_COPY`), plain NOT_FOUND (Task 2 branch + test), tooltip idiom (Task 2), ReceiptSearch failure prop (Task 3), ReceiptView drop-card (Task 3), core symbol trim (Task 1). Relayer-detail-dropped asserted by Task 2's `not.toContain('0xf70d')`.
- Type consistency: `REASON_COPY: Record<FailureReason,…>` (compile-time exhaustive); `FailureNotice`/`ReceiptSearch` both consume `AnalyzeFailure`; `RelayerDetail` symbol removal (Task 1) is independent of the UI (FailureNotice never reads symbols).
