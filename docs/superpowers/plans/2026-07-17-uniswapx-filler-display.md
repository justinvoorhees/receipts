# UniswapX Filler Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the meaningless "Aggregator" row (an unlabeled UniswapX reactor address) with a "Filler / via UniswapX" row showing the filler's address, for UniswapX-anchored receipts.

**Architecture:** Thread `tx.from` (the filler EOA) through as a new `fillerAddress` field — core `Receipt` → DB column → API route → dashboard `ReceiptRow` — populated only when `resolveTrader` anchored via UniswapX (tier 2). The receipt UI swaps the Aggregator row for a new `FillerRow` component whenever both the `ANCHOR_VIA_UNISWAPX` flag and a non-null `fillerAddress` are present; otherwise it falls back to today's Aggregator row unchanged (covers legacy pre-column rows).

**Tech Stack:** TypeScript, Next.js (dashboard), Drizzle ORM + Postgres (db), viem (core), Vitest.

## Global Constraints

- Tasks run **in strict sequence** — each depends on the previous (core field → db column → API mapping → UI). Do not parallelize.
- Scope is the receipt detail view only. `TradesTable.tsx`'s "Aggregator" list column is untouched.
- No backfill of historical rows — `fillerAddress` is `null` on pre-migration receipts, and the UI must degrade gracefully to today's exact output in that case.
- Follow the spec at `docs/superpowers/specs/2026-07-17-uniswapx-filler-display-design.md`.
- Use tabs for indentation, matching the surrounding file (this repo uses tabs throughout).

---

### Task 1: Core — `fillerAddress` on `Receipt`

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts`
- Modify: `packages/core/src/analyzeTransaction.test.ts`
- Modify: `packages/core/src/beneficiaryAnchoring.e2e.test.ts`
- Modify: `packages/dashboard/app/api/receipts/route.test.ts` (compile fixture only — no behavior change yet)

**Interfaces:**
- Produces: `Receipt.fillerAddress: string | null` (new field on the `Receipt` interface). `deriveFillerAddress(anchor: Anchor, txFrom: string): string | null` — exported pure helper, `Anchor` type imported from `./resolveTrader.js`.
- Consumes: `resolveTrader`'s existing `{ trader, anchor }` result (already in scope in `analyzeTransaction()`), and `tx.from` (already fetched).

- [ ] **Step 1: Write the failing unit test for `deriveFillerAddress`**

Add to `packages/core/src/analyzeTransaction.test.ts`, changing the import on line 3 from:

```ts
import { analyzeTransaction, baseIsOutputLeg, toDisplayPrice, splitFabricFee, attachLegSymbols } from './analyzeTransaction.js';
```

to:

```ts
import { analyzeTransaction, baseIsOutputLeg, toDisplayPrice, splitFabricFee, attachLegSymbols, deriveFillerAddress } from './analyzeTransaction.js';
```

Then insert this new `describe` block after the `splitFabricFee` block (after line 69, before `describe('attachLegSymbols', ...)`):

```ts
describe('deriveFillerAddress', () => {
	const TXFROM = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';

	it('returns the lowercased tx.from when anchored via UniswapX', () => {
		expect(deriveFillerAddress({ kind: 'beneficiary', method: 'uniswapx' }, TXFROM)).toBe(TXFROM.toLowerCase());
	});

	it('returns null for a self-anchored trade (no separate filler concept)', () => {
		expect(deriveFillerAddress({ kind: 'self' }, TXFROM)).toBeNull();
	});

	it('returns null for a net-flow-anchored trade (generic relayer, not UniswapX)', () => {
		expect(deriveFillerAddress({ kind: 'beneficiary', method: 'net-flow' }, TXFROM)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/analyzeTransaction.test.ts`
Expected: FAIL — `deriveFillerAddress` is not exported from `./analyzeTransaction.js`.

- [ ] **Step 3: Implement `deriveFillerAddress` and the `fillerAddress` field**

In `packages/core/src/analyzeTransaction.ts`, change the import on line 36 from:

```ts
import { resolveTrader, anchorFlags } from './resolveTrader.js';
```

to:

```ts
import { resolveTrader, anchorFlags, type Anchor } from './resolveTrader.js';
```

Insert this new function after `attachLegSymbols` (after line 137, before `export interface Receipt {`):

```ts
/**
 * The filler/relayer EOA that submitted the transaction, exposed only for
 * UniswapX-anchored trades (resolveTrader tier 2) — self- and net-flow-
 * anchored trades have no separate "filler" concept, so this is null. Pure
 * so it's unit-testable without a live RPC call.
 */
export function deriveFillerAddress(anchor: Anchor, txFrom: string): string | null {
	return anchor.kind === 'beneficiary' && anchor.method === 'uniswapx' ? txFrom.toLowerCase() : null;
}
```

In the `Receipt` interface, change:

```ts
	trader: string;
	direction: string;
```

to:

```ts
	trader: string;
	/** The filler/relayer EOA that submitted the tx, populated only when
	 *  resolveTrader anchored via UniswapX (see deriveFillerAddress); null
	 *  for self- and net-flow-anchored trades. */
	fillerAddress: string | null;
	direction: string;
```

In the returned object at the end of `analyzeTransaction()`, change:

```ts
			trader,
			direction: `${pricing.inputSymbol}->${pricing.outputSymbol}`,
```

to:

```ts
			trader,
			fillerAddress: deriveFillerAddress(resolved.anchor, tx.from),
			direction: `${pricing.inputSymbol}->${pricing.outputSymbol}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/analyzeTransaction.test.ts`
Expected: PASS (all tests including the 3 new `deriveFillerAddress` cases).

- [ ] **Step 5: Fix the now-broken `Receipt` literal in the dashboard's route test (compile-only fix)**

`Receipt` gained a required field, so `sampleReceipt` in `packages/dashboard/app/api/receipts/route.test.ts` no longer satisfies the type. Add one line — after `trader: '0xtrader',`:

```ts
	trader: '0xtrader',
	fillerAddress: null,
```

This keeps the fixture compiling; the actual pass-through mapping is added in Task 3.

- [ ] **Step 6: Run typecheck to verify the fixture compiles**

Run: `npx tsc --build`
Expected: no errors.

- [ ] **Step 7: Extend the live e2e test to cover `fillerAddress`**

In `packages/core/src/beneficiaryAnchoring.e2e.test.ts`, change:

```ts
	it('decodes the Relay relayer trade anchored on its EOA beneficiary', async () => {
		const r = await analyzeTransaction('0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.trader.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		expect(r!.inputSymbol).toBe('USDC');
		expect(r!.outputSymbol).toBe('ETH');
		expect(r!.normalizeFlags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))).toBe(true);
	}, 60000);

	it('decodes a UniswapX single fill anchored on the swapper', async () => {
		const UNISWAPX_FILL_HASH = '0x97a73ba891215ca32d239bbeb2b0e27dea5720890c907940ccfd758dbb691a73';
		const r = await analyzeTransaction(UNISWAPX_FILL_HASH, CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))).toBe(true);
		expect(r!.trader.length).toBe(42); // a resolved swapper address
	}, 60000);
```

to:

```ts
	it('decodes the Relay relayer trade anchored on its EOA beneficiary', async () => {
		const r = await analyzeTransaction('0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.trader.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		expect(r!.inputSymbol).toBe('USDC');
		expect(r!.outputSymbol).toBe('ETH');
		expect(r!.normalizeFlags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))).toBe(true);
		// Net-flow anchoring, not UniswapX — no filler concept applies.
		expect(r!.fillerAddress).toBeNull();
	}, 60000);

	it('decodes a UniswapX single fill anchored on the swapper', async () => {
		const UNISWAPX_FILL_HASH = '0x97a73ba891215ca32d239bbeb2b0e27dea5720890c907940ccfd758dbb691a73';
		const r = await analyzeTransaction(UNISWAPX_FILL_HASH, CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))).toBe(true);
		expect(r!.trader.length).toBe(42); // a resolved swapper address
		expect(r!.fillerAddress).not.toBeNull();
		expect(r!.fillerAddress!.length).toBe(42); // a resolved filler EOA
	}, 60000);
```

- [ ] **Step 8: Run the e2e test to verify it passes against live RPC**

Run: `npx vitest run packages/core/src/beneficiaryAnchoring.e2e.test.ts`
Expected: PASS (uses `TCA_RPC_URL` from the repo-root `.env`, already configured; the file has `import 'dotenv/config'` at the top so no manual env sourcing is needed).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/analyzeTransaction.test.ts packages/core/src/beneficiaryAnchoring.e2e.test.ts packages/dashboard/app/api/receipts/route.test.ts
git commit -m "feat(core): derive fillerAddress for UniswapX-anchored receipts"
```

---

### Task 2: DB — `filler_address` column

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/00XX_<generated_name>.sql` (via `drizzle-kit generate`, exact name/number chosen by the tool)
- Create: `packages/db/drizzle/meta/00XX_snapshot.json` (generated alongside)
- Modify: `packages/db/drizzle/meta/_journal.json` (updated by the generator)

**Interfaces:**
- Consumes: nothing new.
- Produces: `receipts.fillerAddress: string | null` on `ReceiptRow`/`NewReceipt` (both are `typeof schema.receipts.$inferSelect`/`$inferInsert`, so this propagates automatically to `packages/dashboard/lib/queries.ts` and every file importing `ReceiptRow` — no manual type edits needed there).

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, change:

```ts
		routerAddress: text('router_address'),
		trader: text('trader').notNull(),
```

to:

```ts
		routerAddress: text('router_address'),
		trader: text('trader').notNull(),
		// The filler/relayer EOA (tx.from) that submitted a UniswapX-anchored
		// fill; null for self- and net-flow-anchored trades, and for rows
		// persisted before this column existed (no backfill).
		fillerAddress: text('filler_address'),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `packages/db/drizzle/00XX_<name>.sql` containing exactly:

```sql
ALTER TABLE "receipts" ADD COLUMN "filler_address" text;
```

(plus an updated snapshot in `packages/db/drizzle/meta/` and journal entry). Verify the generated SQL file's contents match this single `ADD COLUMN` statement — if drizzle-kit proposes anything else (e.g. a rename), stop and investigate rather than accepting it.

- [ ] **Step 3: Apply the migration**

Run: `npm run db:migrate`
Expected: success output naming the new migration as applied, against `TCA_DATABASE_URL` from `.env`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "feat(db): add nullable filler_address column to receipts"
```

---

### Task 3: API — thread `fillerAddress` through the insert mapping

**Files:**
- Modify: `packages/dashboard/app/api/receipts/route.ts`
- Modify: `packages/dashboard/app/api/receipts/route.test.ts`

**Interfaces:**
- Consumes: `Receipt.fillerAddress` (Task 1), `NewReceipt.fillerAddress` (Task 2, auto-derived from schema).
- Produces: nothing new downstream — this closes the data-layer loop so a freshly-computed receipt's `fillerAddress` reaches the DB row the UI reads.

- [ ] **Step 1: Write the failing test**

In `packages/dashboard/app/api/receipts/route.test.ts`, change the `sampleReceipt` fixture's `fillerAddress: null,` (added in Task 1) to a real value — change:

```ts
	trader: '0xtrader',
	fillerAddress: null,
```

to:

```ts
	trader: '0xtrader',
	fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
```

Then add an assertion in the `'200s computing and inserting when not previously stored'` test, right after the existing `expect(arg.settlementEventSeen).toBe(true);` line:

```ts
		expect(arg.settlementEventSeen).toBe(true);
		expect(arg.fillerAddress).toBe('0xfiller1234567890abcdef1234567890abcdef12');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/app/api/receipts/route.test.ts`
Expected: FAIL — `arg.fillerAddress` is `undefined`, not the expected address (`toNewReceipt` doesn't map it yet).

- [ ] **Step 3: Add the mapping**

In `packages/dashboard/app/api/receipts/route.ts`, inside `toNewReceipt()`, change:

```ts
		trader: r.trader,
		direction: r.direction,
```

to:

```ts
		trader: r.trader,
		fillerAddress: r.fillerAddress,
		direction: r.direction,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/app/api/receipts/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/app/api/receipts/route.ts packages/dashboard/app/api/receipts/route.test.ts
git commit -m "feat(dashboard): persist fillerAddress on receipt insert"
```

---

### Task 4: Dashboard UI — Filler row

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx`
- Modify: `packages/dashboard/components/TradesTable.test.tsx`
- Modify: `packages/dashboard/components/ReceiptView.tsx`
- Modify: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: `row.fillerAddress: string | null`, `row.normalizeFlags` containing `ANCHOR_VIA_UNISWAPX: ...` (Tasks 1–3).
- Produces: `isUniswapXFillerRow(row): boolean` (exported from `TradesTable.tsx`, imported into `ReceiptView.tsx`), `FillerRow` component (private to `ReceiptView.tsx`).

- [ ] **Step 1: Write the failing test for `isUniswapXFillerRow`**

Add to `packages/dashboard/components/TradesTable.test.tsx`, right after the `describe('beneficiaryAnchorNote', ...)` block (after line 721):

```ts
describe('isUniswapXFillerRow', () => {
	it('is false for a normal (self-anchored) receipt', async () => {
		const { isUniswapXFillerRow } = await import('./TradesTable');
		expect(isUniswapXFillerRow({ normalizeFlags: ['SETTLEMENT_EVENT_MISSING: x'], fillerAddress: null })).toBe(false);
	});

	it('is true when UniswapX-anchored and fillerAddress is present', async () => {
		const { isUniswapXFillerRow } = await import('./TradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		})).toBe(true);
	});

	it('is false when UniswapX-anchored but fillerAddress is null (legacy pre-column row)', async () => {
		const { isUniswapXFillerRow } = await import('./TradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
			fillerAddress: null,
		})).toBe(false);
	});

	it('is false for a net-flow-anchored (non-UniswapX) relayer trade even with a fillerAddress', async () => {
		const { isUniswapXFillerRow } = await import('./TradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y'],
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		})).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: FAIL — `isUniswapXFillerRow` is not exported from `./TradesTable`.

- [ ] **Step 3: Implement `isUniswapXFillerRow`**

In `packages/dashboard/components/TradesTable.tsx`, insert this function right after the `beneficiaryAnchorNote` function (after line 601, before `export function getFlagLabel`):

```ts
/** True when this receipt should show the Filler row (UniswapX-anchored AND
 *  a fillerAddress was persisted) in place of the Aggregator row. Rows
 *  anchored via UniswapX before the fillerAddress column existed (null)
 *  fall back to the ordinary Aggregator row — see ReceiptView. */
export function isUniswapXFillerRow(row: Partial<Pick<ReceiptRow, 'normalizeFlags' | 'fillerAddress'>>): boolean {
	if (row.fillerAddress == null) return false;
	const flags = Array.isArray(row.normalizeFlags) ? row.normalizeFlags.filter((f): f is string => typeof f === 'string') : [];
	return flags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing render tests for the Filler row**

Add to `packages/dashboard/components/ReceiptView.test.tsx`, right after the `describe('Receipt header', ...)` block closes (after line 181, before `describe('Receipt Fabric partner-fee attribution', ...)`):

```ts
describe('UniswapX Filler row', () => {
	const fillerRow = {
		...fullUsdcWethRow,
		fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
	};

	it('replaces the Aggregator row with Filler / via UniswapX + a Basescan link to the filler', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={fillerRow as never} hash={fillerRow.txHash} />);
		expect(html).toContain('Filler');
		expect(html).toContain('via UniswapX');
		expect(html).toContain(`href="https://basescan.org/address/${fillerRow.fillerAddress}"`);
		expect(html).not.toContain('>Aggregator<');
		// The row itself now conveys "via UniswapX" — the separate note is redundant.
		expect(html).not.toContain('Executed on your behalf via UniswapX');
	});

	it('falls back to the ordinary Aggregator row + note when fillerAddress is null (legacy row)', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const legacyRow = { ...fillerRow, fillerAddress: null };
		const html = renderToStaticMarkup(<ReceiptView trade={legacyRow as never} hash={legacyRow.txHash} />);
		expect(html).toContain('>Aggregator<');
		expect(html).toContain('Executed on your behalf via UniswapX');
		expect(html).not.toContain('>Filler<');
	});

	it('leaves a non-UniswapX beneficiary-anchored (net-flow) row unaffected', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const netFlowRow = {
			...fullUsdcWethRow,
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
			normalizeFlags: ['BENEFICIARY_ANCHORED: y'],
		};
		const html = renderToStaticMarkup(<ReceiptView trade={netFlowRow as never} hash={netFlowRow.txHash} />);
		expect(html).toContain('>Aggregator<');
		expect(html).toContain('Executed on your behalf by a solver');
		expect(html).not.toContain('>Filler<');
	});
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: FAIL — `fillerRow`/`legacyRow`/`netFlowRow` render today's Aggregator row for all three cases (no `FillerRow` exists yet), so the first test's assertions on `'Filler'`/`'via UniswapX'`/the filler Basescan link fail.

- [ ] **Step 7: Implement `FillerRow` and wire it into `Receipt`**

In `packages/dashboard/components/ReceiptView.tsx`, add `isUniswapXFillerRow` to the import from `./TradesTable` — change:

```ts
	RFQ_LEG_TOOLTIP,
	isMakerLeg,
	NULL_PRICE_TOOLTIP,
	beneficiaryAnchorNote,
} from './TradesTable';
```

to:

```ts
	RFQ_LEG_TOOLTIP,
	isMakerLeg,
	NULL_PRICE_TOOLTIP,
	beneficiaryAnchorNote,
	isUniswapXFillerRow,
} from './TradesTable';
```

Insert this new component right after `AggregatorValue` (after line 227, before `function BkdHeading`):

```ts
/**
 * Filler detail row: replaces the Aggregator row for UniswapX-anchored
 * trades — there is no aggregator here, only the filler who submitted the
 * fill on the swapper's behalf. Two-line label (Filler / via UniswapX),
 * same grid shell as DetailRow so it lines up with every other row.
 */
function FillerRow({ address }: { address: string }) {
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
```

In the `Receipt()` function, change:

```ts
	const legs = normalizeRouteLegs(row.routeLegs);
```

to:

```ts
	const legs = normalizeRouteLegs(row.routeLegs);
	const showFillerRow = isUniswapXFillerRow(row);
```

Then change:

```tsx
				<DetailRow label="Aggregator">
					<AggregatorValue row={row} />
				</DetailRow>
				{beneficiaryAnchorNote(row) && (
					<p className="text-[var(--color-secondary)]">{beneficiaryAnchorNote(row)}</p>
				)}
```

to:

```tsx
				{showFillerRow ? (
					<FillerRow address={row.fillerAddress as string} />
				) : (
					<DetailRow label="Aggregator">
						<AggregatorValue row={row} />
					</DetailRow>
				)}
				{!showFillerRow && beneficiaryAnchorNote(row) && (
					<p className="text-[var(--color-secondary)]">{beneficiaryAnchorNote(row)}</p>
				)}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: PASS (all 3 new cases, plus every pre-existing test in the file still green — the `fullUsdcWethRow` fixture has no `ANCHOR_VIA_UNISWAPX` flag and no `fillerAddress`, so `isUniswapXFillerRow` is false for it and the Aggregator row renders exactly as before).

- [ ] **Step 9: Full-repo verification**

Run: `npx tsc --build && npx vitest run`
Expected: typecheck clean, full suite green across `packages/core`, `packages/db`, and `packages/dashboard`.

- [ ] **Step 10: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): show Filler/via UniswapX row in place of Aggregator for UniswapX-anchored receipts"
```
