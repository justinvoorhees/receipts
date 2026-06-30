# Receipts Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Receipts tab (hash-searchable trade receipt page) and rename Trades → History, hiding the Dashboard tab from the nav.

**Architecture:** URL-query-param driven (`/receipts?tx=0x…`). The server component `app/receipts/page.tsx` reads `searchParams.tx`, calls `getTradeByHash`, and passes `{ trade, hash }` to the client component `ReceiptView`. `ReceiptSearch` (client) controls the input and navigates via `router.push`. The existing `TransactionDetailsDialog` and its utility functions are reused by exporting helpers from `TradesTable.tsx`.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS v4, TypeScript, Vitest.

## Global Constraints

- All fonts use `font-['Sohne_Breit']` (labels/headings) and `font-['Sohne_Mono']` (data rows).
- Color tokens from `theme.css`: `--color-primary`, `--color-secondary`, `--color-quaternary`, `--color-surface-low`, `--color-border`, `--color-red` (#fa0b54 — used for error state), `--color-success` / `#117d45` (positive bps values), `--color-warning`.
- History tab scoped to `getCuratedTrades()` — only those hashes are valid in the receipt search.
- Default hash: `0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1`.
- Error message text: `Transaction not found in History.`
- "Total Execution Quality" (receipt cost breakdown footer row) — not "Total Accuracy".
- `export const revalidate = 30` on all page files.
- Prototype — no test coverage required for DB-touching functions or Next.js-hook components. Tests cover pure functions only.

---

## File Map

| Status | Path | Responsibility |
|--------|------|---------------|
| Modify | `packages/dashboard/components/NavTabs.tsx` | Add `hidden` flag; hide Dashboard; rename Trades→History; add Receipts |
| Modify | `packages/dashboard/app/trades/page.tsx` | Rename h1 "Trades" → "History" |
| Modify | `packages/dashboard/lib/queries.ts` | Add `getTradeByHash(hash)` |
| Modify | `packages/dashboard/components/TradesTable.tsx` | Export 6 private helpers needed by ReceiptView |
| Create | `packages/dashboard/components/ReceiptSearch.tsx` | Client: hash input, submit button, error state |
| Create | `packages/dashboard/components/ReceiptView.tsx` | Client: full receipt layout; `formatDelta` |
| Create | `packages/dashboard/components/ReceiptView.test.tsx` | Unit test for `formatDelta` |
| Create | `packages/dashboard/app/receipts/page.tsx` | Server: read searchParams, fetch, render |

---

### Task 1: NavTabs hidden flag + Trades heading rename

**Files:**
- Modify: `packages/dashboard/components/NavTabs.tsx`
- Modify: `packages/dashboard/app/trades/page.tsx`

**Interfaces:**
- Produces: `NavTabs` renders Receipts + History tabs (Dashboard hidden); `/trades` page h1 reads "History"

- [ ] **Step 1: Update NavTabs.tsx**

Replace the full file content:

```tsx
'use client';
import type { Route } from 'next';
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

const TABS: { label: string; href: Route; matches: (path: string) => boolean; hidden?: boolean }[] = [
	{ label: 'Dashboard', href: '/' as Route, matches: (p) => p === '/', hidden: true },
	{
		label: 'Receipts',
		href: '/receipts' as Route,
		matches: (p) => p === '/receipts',
	},
	{
		label: 'History',
		href: '/trades' as Route,
		matches: (p) => p === '/trades' || p.startsWith('/trades/'),
	},
];

export function NavTabs() {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	const [pending, startTransition] = useTransition();

	return (
		<nav className="flex gap-[40px] items-center">
			{TABS.filter((tab) => !tab.hidden).map((tab) => {
				const selected = tab.matches(pathname);
				const className = selected
					? 'text-[var(--color-primary)] underline decoration-dotted'
					: [
							'text-[var(--color-secondary)]',
							'hover:underline hover:decoration-solid',
							'active:text-[var(--color-quaternary)]',
						].join(' ');
				const onClick = (e: React.MouseEvent) => {
					if (selected) return;
					e.preventDefault();
					startTransition(() => router.push(tab.href));
				};
				return (
					<a
						key={tab.href}
						href={tab.href}
						onClick={onClick}
						className={`tab-underline font-['Sohne_Breit'] text-[16px] leading-[16px] transition-opacity ${className} ${pending ? 'opacity-60' : ''}`}
					>
						{tab.label}
					</a>
				);
			})}
		</nav>
	);
}
```

- [ ] **Step 2: Update h1 in trades page**

In `packages/dashboard/app/trades/page.tsx` line 29, change:
```tsx
						Trades
```
to:
```tsx
						History
```

- [ ] **Step 3: Verify visually**

Run `npm run dev` from the project root. Open http://localhost:3002. Confirm:
- Nav shows "Receipts" and "History" only (no "Dashboard").
- Navigating to `/trades` shows "History" as the page heading.
- Navigating to `/` still works (Dashboard page loads).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/components/NavTabs.tsx packages/dashboard/app/trades/page.tsx
git commit -m "feat(nav): add Receipts tab, rename Trades→History, hide Dashboard"
```

---

### Task 2: getTradeByHash query

**Files:**
- Modify: `packages/dashboard/lib/queries.ts`

**Interfaces:**
- Produces: `export async function getTradeByHash(hash: string): Promise<TradeRow | null>`

- [ ] **Step 1: Add function to queries.ts**

Append after the `getCuratedAggregatorSummary` function (end of file):

```ts
/**
 * Looks up a single trade from the curated set by its transaction hash.
 * Returns null if the hash is not in the History dataset.
 */
export async function getTradeByHash(hash: string): Promise<TradeRow | null> {
	const rows = await getCuratedTrades();
	return rows.find((r) => r.txHash.toLowerCase() === hash.toLowerCase()) ?? null;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/lib/queries.ts
git commit -m "feat(queries): add getTradeByHash lookup"
```

---

### Task 3: Export helpers from TradesTable

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx`

**Interfaces:**
- Produces (new exports):
  - `export function formatExecutionPrice(value: unknown): string`
  - `export function formatSubvalueUsd(value: number): string`
  - `export function formatTokenIn(row: TradeRow): string`
  - `export function formatTokenOut(row: TradeRow): string`
  - `export function normalizeRouteLegs(routeLegs: TradeRow['routeLegs'] | string | null | undefined): RouteLeg[]`
  - `export function routePath(legs: RouteLeg[]): string`
  - `export function tokenSymbol(address: string): string`

- [ ] **Step 1: Add export keyword to seven private functions**

In `packages/dashboard/components/TradesTable.tsx`, add `export` to each of these function declarations (they are currently private):

Line ~560: `function formatExecutionPrice` → `export function formatExecutionPrice`

Line ~443: `function formatSubvalueUsd` → `export function formatSubvalueUsd`

Line ~704: `function formatTokenIn` → `export function formatTokenIn`

Line ~708: `function formatTokenOut` → `export function formatTokenOut`

Line ~669: `function normalizeRouteLegs` → `export function normalizeRouteLegs`

Line ~680: `function routePath` → `export function routePath`

Line ~665: `function tokenSymbol` → `export function tokenSymbol`

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx
git commit -m "refactor(TradesTable): export helper functions for ReceiptView reuse"
```

---

### Task 4: ReceiptSearch component

**Files:**
- Create: `packages/dashboard/components/ReceiptSearch.tsx`

**Interfaces:**
- Consumes: `hash: string`, `error?: string` props; `useRouter` from `next/navigation`
- Produces: `export function ReceiptSearch({ hash, error }: { hash: string; error?: string })`

- [ ] **Step 1: Create ReceiptSearch.tsx**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReceiptSearch({ hash, error }: { hash: string; error?: string }) {
	const router = useRouter();
	const [value, setValue] = useState(hash);

	useEffect(() => {
		setValue(hash);
	}, [hash]);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed) router.push(`/receipts?tx=${trimmed}`);
	};

	const hasError = error != null;
	const borderColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const textColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const labelColor = hasError ? 'var(--color-red)' : 'var(--color-secondary)';

	return (
		<div className="flex flex-col gap-[10px] w-full">
			<span
				className="font-['Sohne_Breit'] text-[12px] leading-[12px]"
				style={{ color: labelColor }}
			>
				Transaction Hash
			</span>
			<div className="relative flex h-[40px] w-full items-center">
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
					spellCheck={false}
					className="h-full w-full rounded-[2px] border pl-[12px] pr-[48px] font-['Sohne_Mono'] text-[12px] leading-[12px] bg-transparent outline-none"
					style={{
						borderColor,
						color: textColor,
						fontFeatureSettings: '"calt" 0',
					}}
				/>
				<button
					type="button"
					onClick={submit}
					aria-label="Search transaction"
					className="absolute right-[-1px] top-[-1px] flex h-[40px] w-[40px] items-center justify-center rounded-[2px] p-[8px]"
					style={{ backgroundColor: 'var(--color-primary)' }}
				>
					<svg
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
						style={{ color: 'var(--color-surface-base)' }}
					>
						<path
							d="M5 12h14M13 6l6 6-6 6"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>
			{hasError && (
				<span
					className="font-['Sohne_Breit'] text-[12px] leading-[12px]"
					style={{ color: 'var(--color-red)' }}
				>
					{error}
				</span>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/components/ReceiptSearch.tsx
git commit -m "feat(receipts): add ReceiptSearch component with error state"
```

---

### Task 5: ReceiptView component

**Files:**
- Create: `packages/dashboard/components/ReceiptView.tsx`
- Create: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes:
  - `trade: TradeRow | null` from `queries.ts`
  - `hash: string`
  - All formatters from `TradesTable.tsx` and `formatters.ts`
- Produces:
  - `export function ReceiptView({ trade, hash }: { trade: TradeRow | null; hash: string })`
  - `export function formatDelta(marketMid: unknown, realizedPrice: unknown): string`

- [ ] **Step 1: Write failing test for formatDelta**

Create `packages/dashboard/components/ReceiptView.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';

describe('formatDelta', () => {
	it('returns the absolute dollar difference between market and execution price', async () => {
		const { formatDelta } = await import('./ReceiptView');
		// Figma example: market 1830.44284125, realized 1829.763683289442 → $0.68
		expect(formatDelta(1830.44284125, 1829.763683289442)).toBe('$0.68');
	});

	it('returns the same value when realized > market', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(1829.00, 1830.00)).toBe('$1.00');
	});

	it('returns – for null inputs', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(null, 1829.0)).toBe('–');
		expect(formatDelta(1830.0, null)).toBe('–');
	});
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A5 "ReceiptView"
```

Expected: FAIL — `Cannot find module './ReceiptView'`

- [ ] **Step 3: Create ReceiptView.tsx**

```tsx
'use client';
import { ReceiptSearch } from './ReceiptSearch';
import type { TradeRow, RouteLeg } from '../lib/queries';
import {
	formatProvider,
	providerColor,
	shortTxHash,
	formatGasUsd,
} from '../lib/formatters';
import {
	formatDialogBps,
	formatExecutionPrice,
	formatSubvalueUsd,
	formatTokenIn,
	formatTokenOut,
	normalizeRouteLegs,
	routePath,
	tokenSymbol,
	getExecutionBreakdown,
	getPriceImpactRows,
	getVenueLabel,
	getAggregatorFeeAttribution,
} from './TradesTable';

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';

export function formatDelta(marketMid: unknown, realizedPrice: unknown): string {
	const mid = marketMid == null ? null : Number(marketMid);
	const exec = realizedPrice == null ? null : Number(realizedPrice);
	if (mid == null || exec == null || !Number.isFinite(mid) || !Number.isFinite(exec)) return '–';
	return `$${Math.abs(mid - exec).toFixed(2)}`;
}

function receiptPairTitle(legs: RouteLeg[], row: TradeRow): string {
	if (legs.length === 0) return row.settledIn ?? 'WETH';
	const tokens = [legs[0]!.tokenIn, ...legs.map((l) => l.tokenOut)];
	const symbols = tokens.map(tokenSymbol);
	// Reverse to show pricing convention: "WETH→USDC" (last→first)
	return `${symbols[symbols.length - 1]}→${symbols[0]}`;
}

function Divider({ dashed = false }: { dashed?: boolean }) {
	if (dashed) {
		return (
			<div
				className="h-px w-full shrink-0"
				style={{
					backgroundImage:
						'repeating-linear-gradient(to right, var(--color-border) 0, var(--color-border) 1px, transparent 1px, transparent 3px)',
				}}
			/>
		);
	}
	return <div className="h-px w-full shrink-0 bg-[var(--color-primary)]" />;
}

function DetailRow({
	label,
	children,
	underscored = false,
	subvalue,
}: {
	label: string;
	children: React.ReactNode;
	underscored?: boolean;
	subvalue?: string;
}) {
	return (
		<div className="grid grid-cols-[180px_1fr] gap-x-[24px]">
			<span
				className={`text-[var(--color-secondary)] ${underscored ? 'underline decoration-dotted underline-offset-[3px]' : ''}`}
			>
				{label}
			</span>
			{subvalue != null ? (
				<div className="flex flex-col gap-[5px] items-end min-w-0">
					<span>{children}</span>
					<span className="text-[var(--color-secondary)]">{subvalue}</span>
				</div>
			) : (
				<span className="min-w-0 text-right">{children}</span>
			)}
		</div>
	);
}

function BkdHeading({
	label,
	value,
	color,
	tooltip,
}: {
	label: string;
	value?: string;
	color?: string;
	tooltip?: string;
}) {
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			{tooltip ? (
				<span className="group relative cursor-default underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
					{label}
					<div
						role="tooltip"
						className="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
					>
						{tooltip}
					</div>
				</span>
			) : (
				<span className="underline decoration-dotted underline-offset-[3px]">{label}</span>
			)}
			{value != null && (
				<span className="text-right" style={color ? { color } : undefined}>
					{value}
				</span>
			)}
		</div>
	);
}

function BkdRow({
	label,
	value,
	context,
	href,
	color,
	valueTooltip,
	secondary = false,
	plain = false,
}: {
	label: string;
	value: string;
	context?: string;
	href?: string;
	color?: string;
	valueTooltip?: string;
	secondary?: boolean;
	plain?: boolean;
}) {
	const labelClass = [
		plain ? '' : 'underline decoration-dotted underline-offset-[3px]',
		secondary ? 'text-[var(--color-secondary)]' : '',
	]
		.filter(Boolean)
		.join(' ');
	const labelNode = href ? (
		<a href={href} target="_blank" rel="noreferrer" className={`${labelClass} hover:decoration-solid`}>
			{label}
		</a>
	) : (
		<span className={labelClass}>{label}</span>
	);
	return (
		<div className="grid grid-cols-[1fr_92px] gap-x-[24px]">
			<div className="min-w-0">
				{labelNode}
				{context != null && (
					<span className="ml-[10px] text-[var(--color-quaternary)]">{context}</span>
				)}
			</div>
			{valueTooltip ? (
				<span className="group relative text-right cursor-default" style={color ? { color } : undefined}>
					<span className="underline decoration-dotted underline-offset-[3px] group-hover:decoration-solid">{value}</span>
					<span
						role="tooltip"
						className="pointer-events-none absolute bottom-full right-0 z-10 mb-[8px] w-[280px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible"
					>
						{valueTooltip}
					</span>
				</span>
			) : (
				<span className="text-right" style={color ? { color } : undefined}>
					{value}
				</span>
			)}
		</div>
	);
}

export function ReceiptView({ trade, hash }: { trade: TradeRow | null; hash: string }) {
	const error = trade === null ? 'Transaction not found in History.' : undefined;

	return (
		<div className="flex flex-col gap-[40px] pb-10">
			<h1
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Create Receipt
			</h1>

			<ReceiptSearch hash={hash} error={error} />

			{trade != null && <Receipt row={trade} />}
		</div>
	);
}

function Receipt({ row }: { row: TradeRow }) {
	const legs = normalizeRouteLegs(row.routeLegs);
	const costBps = Number(row.allInCostBps);
	const { text: accuracy, color: accuracyColor } = formatDialogBps(-costBps);
	const agg = formatDialogBps(row.aggFeeBps != null ? -Number(row.aggFeeBps) : null);
	const hasAggFee = row.aggFeeBps != null && Number(row.aggFeeBps) !== 0;
	const execution = getExecutionBreakdown(row);
	const priceImpactRows = getPriceImpactRows(legs);
	const pairTitle = receiptPairTitle(legs, row);

	return (
		<>
			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				{pairTitle}
			</h2>

			{/* Detail table */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<DetailRow label="Txn Hash">
					<a
						href={`https://basescan.org/tx/${row.txHash}`}
						target="_blank"
						rel="noreferrer"
						className="underline decoration-dotted underline-offset-[3px] hover:decoration-solid"
					>
						{shortTxHash(row.txHash)}
					</a>
				</DetailRow>
				<DetailRow label="Chain">Base</DetailRow>
				<DetailRow label="Block">{row.blockNumber.toLocaleString()}</DetailRow>
				<DetailRow label="Aggregator">
					<span style={{ color: providerColor(row.aggregator.toLowerCase()) }}>
						{formatProvider(row.aggregator.toLowerCase())}
					</span>
				</DetailRow>
				<DetailRow label="Route">{routePath(legs)}</DetailRow>

				<Divider dashed />

				<DetailRow
					label="Token In"
					subvalue={formatSubvalueUsd(Number(row.usdcAmount))}
				>
					{formatTokenIn(row)}
				</DetailRow>
				<DetailRow
					label="Token Out"
					subvalue={formatSubvalueUsd(Number(row.wethAmount) * Number(row.realizedPrice))}
				>
					{formatTokenOut(row)}
				</DetailRow>
				<DetailRow
					label="Realized Execution Price"
					subvalue={formatSubvalueUsd(Number(row.realizedPrice))}
				>
					{formatExecutionPrice(row.realizedPrice)}
				</DetailRow>
				<DetailRow
					label="Market Price"
					underscored
					subvalue={formatSubvalueUsd(Number(row.marketMid))}
				>
					{formatExecutionPrice(row.marketMid)}
					{row.manipulationFlag ? (
						<span
							className="ml-2"
							style={{ color: 'var(--color-warning)' }}
							title="Median pool mid deviates from Chainlink ETH/USD by more than 0.5% at N-1"
						>
							⚠ Possible manipulation
						</span>
					) : null}
				</DetailRow>
				<DetailRow label="Delta">{formatDelta(row.marketMid, row.realizedPrice)}</DetailRow>
				<DetailRow label="Gas Cost">
					{formatGasUsd(row.gasCostUsd != null ? Number(row.gasCostUsd) : null)}
				</DetailRow>
			</div>

			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Cost Breakdown
			</h2>

			{/* Cost breakdown */}
			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
				<BkdHeading label="LP Fee" />
				{legs.length > 0 ? (
					legs.map((leg, index) => {
						const { text: lpText, color: lpColor } = formatDialogBps(-leg.lpFeeBps);
						return (
							<BkdRow
								key={`${leg.venue}-${index}`}
								label={getVenueLabel(leg)}
								href={`https://basescan.org/address/${leg.venue}`}
								context={`${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`}
								value={lpText}
								color={lpColor}
								secondary
							/>
						);
					})
				) : (
					<BkdRow label="Route" value="–" secondary />
				)}

				<Divider dashed />

				{hasAggFee ? (
					<>
						<BkdHeading label="Aggregator Fee" />
						<BkdRow
							label={getAggregatorFeeAttribution(row).label}
							href={getAggregatorFeeAttribution(row).href}
							value={agg.text}
							color={agg.color}
							secondary
						/>
					</>
				) : (
					<BkdHeading label="Aggregator Fee" value="0.00bps" />
				)}

				<Divider dashed />

				<BkdHeading
					label="Price Impact"
					tooltip="Per-venue delta between realized execution price the venue's prior-block mid, excluding L.P. fee"
				/>
				{priceImpactRows.length > 0 ? (
					priceImpactRows.map((impact, index) => (
						<BkdRow
							key={`${impact.href ?? impact.label}-${index}`}
							label={impact.label}
							href={impact.href}
							context={impact.context}
							value={impact.value}
							color={impact.color}
							valueTooltip={impact.valueTooltip}
							secondary
						/>
					))
				) : (
					<BkdRow label="Route" value="–" secondary />
				)}

				<Divider dashed />

				<BkdHeading
					label="Slippage"
					value={execution.marketForcesDisplay.text}
					color={execution.marketForcesDisplay.color}
					tooltip="Residual delta between realized execution price and market mid after L.P. fees, aggregator fees, and price impact"
				/>

				<Divider />
				<BkdRow label="Total Execution Quality" value={accuracy} color={accuracyColor} plain />
			</div>
		</>
	);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A10 "ReceiptView"
```

Expected: 3 passing tests for `formatDelta`.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(receipts): add ReceiptView component with formatDelta"
```

---

### Task 6: Receipts page (server component)

**Files:**
- Create: `packages/dashboard/app/receipts/page.tsx`

**Interfaces:**
- Consumes: `getTradeByHash` from `lib/queries.ts`; `ReceiptView` from `components/ReceiptView.tsx`
- Produces: Next.js page at `/receipts?tx=<hash>`

- [ ] **Step 1: Create app/receipts/page.tsx**

```tsx
import { getTradeByHash } from '../../lib/queries';
import { ReceiptView } from '../../components/ReceiptView';

export const revalidate = 30;

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';

export default async function ReceiptsPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const hash = (sp.tx ?? DEFAULT_HASH).trim();
	const trade = await getTradeByHash(hash);

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={trade} hash={hash} />
		</div>
	);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all tests pass (including the 3 new `formatDelta` tests).

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Open http://localhost:3002/receipts.

Confirm:
1. Nav shows Receipts (selected, dotted underline) and History.
2. Page heading reads "Create Receipt".
3. Input pre-filled with the default hash; receipt renders below with pair title, detail rows (including Delta), and Cost Breakdown.
4. Navigate to http://localhost:3002/receipts?tx=0xBADHASH — input shows the bad hash, red border, red label, error message "Transaction not found in History." below, no receipt content.
5. Paste a valid hash from the History tab and press Enter — receipt updates to show that trade.
6. Navigate to http://localhost:3002/trades — page heading reads "History".
7. Navigate to http://localhost:3002 — Dashboard still loads normally.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/app/receipts/page.tsx
git commit -m "feat(receipts): add /receipts page with hash search and default trade"
```
