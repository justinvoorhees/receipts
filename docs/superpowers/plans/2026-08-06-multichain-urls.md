# Multi-Chain Receipt URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the chain out of a hardcoded constant and into the receipt URL, making `/tx/base/0x…` the canonical address for a receipt.

**Architecture:** A dependency-free chain registry (`lib/chains.ts`) owns the slug ↔ id ↔ explorer mapping. A pure resolver (`lib/receiptUrl.ts`) turns URL segments into one of three outcomes — render, redirect, or 404 — with no Next or React involvement, so the entire canonicalization matrix is unit-testable without standing up a request. The new `app/tx/[chain]/[hash]/page.tsx` is a thin adapter that maps those outcomes onto `notFound()` / `permanentRedirect()` / a render. This mirrors the existing `middleware.ts` ↔ `lib/accessDecision.ts` split. Data access goes through a one-function seam, `lib/loadReceipt.ts`, so the database removal that follows replaces one function body and touches no routing.

**Tech Stack:** Next.js 15 (App Router, `typedRoutes: true`), React 19 server components, TypeScript, Vitest, Drizzle ORM, Postgres.

**Spec:** `docs/superpowers/specs/2026-08-06-multichain-urls-design.md`

## Global Constraints

- **Working directory is the repo root** (`/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder`). All test commands are run from there. Dashboard file paths below are relative to `packages/dashboard/`.
- **There is no vitest config file.** Vitest runs from the root with defaults and discovers `**/*.test.ts(x)`. Run a single file with `npx vitest run <path-from-repo-root>`.
- **`lib/chains.ts` and `lib/receiptUrl.ts` must stay import-free of server-only modules.** Client components (`'use client'`) import both. Never import `./db`, `./queries`, `next/headers`, or any node builtin into either file. `lib/loadReceipt.ts` is the server-only file and is kept separate for exactly this reason.
- **`npm test` does NOT typecheck.** Run `npx tsc --build` separately. Lint is what fails the Railway deploy: `npm run lint`.
- **Never run `npm run build` while a dev server is running** — the root build writes into the same `.next` directory `next dev` owns and the app renders unstyled.
- **Canonical URL form:** `/tx/<slug>/<lowercase-hash>`. The only registered chain is Base: `{ id: 8453, slug: 'base', name: 'Base', explorer: 'https://basescan.org' }`.
- **Hash validation regex, used everywhere:** `/^0x[0-9a-fA-F]{64}$/`.
- **Redirects are 308** via `permanentRedirect` from `next/navigation`, never 307 `redirect`.
- **One hop only.** A request with both a non-canonical chain segment and a mixed-case hash must reach the canonical URL in a single redirect.
- **Tabs, not spaces.** The codebase indents with tabs; match it.
- **Commit after every task.** Co-author trailer on each commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `lib/chains.ts` | The chain registry: `Chain`, `CHAINS`, `DEFAULT_CHAIN`, `chainById`, `resolveChainParam`, `explorerTx`, `explorerAddress`. No imports. |
| `lib/chains.test.ts` | Registry resolution + the single-chain tripwire test. |
| `lib/receiptUrl.ts` | Pure URL policy: `receiptPath`, `resolveReceiptUrl`, `legacyReceiptRedirect`, `HASH_RE`. |
| `lib/receiptUrl.test.ts` | The full canonicalization matrix from spec §1. |
| `lib/loadReceipt.ts` | The data seam the DB removal will re-implement. |
| `lib/loadReceipt.test.ts` | Proves the seam delegates and passes the hash through. |
| `app/tx/[chain]/[hash]/page.tsx` | The receipt route. Thin adapter over `resolveReceiptUrl`. |
| `app/tx/[chain]/[hash]/page.test.tsx` | Wiring: notFound / permanentRedirect / render. |
| `app/page.test.tsx` | Index is search-only and 308s legacy `?tx=` links. |

**Modified:**

| File | Change |
|---|---|
| `app/page.tsx` | Sheds the receipt render, the diagnosis limiter, and `classifyTransaction`. Keeps `?tx=` solely to redirect. |
| `app/api/receipts/route.ts:25,29` | `DEFAULT_CHAIN_ID` / `SUPPORTED_CHAIN_IDS` derive from the registry. |
| `components/receiptSearch.tsx:76` | Navigates to `receiptPath(DEFAULT_CHAIN, hash)`. |
| `components/tradesTable.tsx:362` | `sharePath` from `chainById(row.chainId)`; omitted when null. |
| `lib/alerts.ts:131` | Slack link uses `receiptPath`. |
| `lib/alerts.test.ts:171,182` | Assertions updated to the new path. |
| `app/api/receipts/activityNotify.test.ts:83` | Assertion updated to the new path. |
| `lib/accessDecision.test.ts` | Pins `/tx/base/<hash>` as public. |
| `components/receiptView.tsx:159` | `explorerTx(DEFAULT_CHAIN, …)`. |
| `components/receipt/receiptDisplay.tsx:330,344,632` | `explorerAddress(DEFAULT_CHAIN, …)`. |
| `components/receipt/receiptRows.tsx:220,246,412,491` | `explorerAddress(DEFAULT_CHAIN, …)`. |

**Task order is a dependency chain.** Task 5 (index redirect) must not land before Task 4 (the `/tx` route exists), or every redirected link 404s.

---

## Task 1: Chain registry

**Files:**
- Create: `packages/dashboard/lib/chains.ts`
- Test: `packages/dashboard/lib/chains.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Chain { readonly id: number; readonly slug: string; readonly name: string; readonly explorer: string }`
  - `const CHAINS: readonly Chain[]`
  - `const DEFAULT_CHAIN: Chain`
  - `chainById(id: number): Chain | null`
  - `resolveChainParam(param: string): { chain: Chain; canonical: boolean } | null`
  - `explorerTx(chain: Chain, hash: string): string`
  - `explorerAddress(chain: Chain, address: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/lib/chains.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	CHAINS,
	DEFAULT_CHAIN,
	chainById,
	explorerAddress,
	explorerTx,
	resolveChainParam,
} from './chains';

describe('chain registry', () => {
	it('defaults to Base', () => {
		expect(DEFAULT_CHAIN.id).toBe(8453);
		expect(DEFAULT_CHAIN.slug).toBe('base');
		expect(DEFAULT_CHAIN.name).toBe('Base');
	});

	it('resolves a canonical slug', () => {
		expect(resolveChainParam('base')).toEqual({ chain: DEFAULT_CHAIN, canonical: true });
	});

	it('resolves a mis-cased slug as NON-canonical so the caller redirects', () => {
		expect(resolveChainParam('BASE')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
		expect(resolveChainParam('Base')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
	});

	it('resolves the numeric id as a NON-canonical alias', () => {
		expect(resolveChainParam('8453')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
	});

	it('rejects unregistered slugs and ids', () => {
		expect(resolveChainParam('arbitrum')).toBeNull();
		expect(resolveChainParam('1')).toBeNull();
		expect(resolveChainParam('42161')).toBeNull();
		expect(resolveChainParam('')).toBeNull();
	});

	// A hex chain id would be a second spelling of the same thing, and the API
	// contract at app/api/receipts/route.ts takes a JSON number. Decimal only.
	it('rejects a hex-spelled chain id', () => {
		expect(resolveChainParam('0x2105')).toBeNull();
	});

	it('looks a chain up by id', () => {
		expect(chainById(8453)).toEqual(DEFAULT_CHAIN);
		expect(chainById(1)).toBeNull();
	});

	it('builds explorer URLs', () => {
		expect(explorerTx(DEFAULT_CHAIN, '0xabc')).toBe('https://basescan.org/tx/0xabc');
		expect(explorerAddress(DEFAULT_CHAIN, '0xdef')).toBe('https://basescan.org/address/0xdef');
	});
});

// ─── Tripwire ────────────────────────────────────────────────────────────────
// This test is SUPPOSED to fail when someone adds a chain. That is its entire
// purpose. Read the failure message, pay the two debts it names, then update
// the expected length. Do not delete it.
describe('single-chain assumptions', () => {
	it('has exactly one registered chain', () => {
		expect(
			CHAINS.length,
			[
				'A second chain was added. Two things are now silently WRONG and must be fixed in this same change:',
				'',
				'  1. lib/queries.ts getReceiptByHash() matches on lower(tx_hash) alone and ignores chain_id,',
				'     even though the unique key is (user_id, tx_hash, chain_id). Two chains sharing a tx hash',
				'     are interchangeable to it. Add a chainId parameter and filter on it.',
				'',
				'  2. The 8 explorer links in receiptView.tsx, receipt/receiptDisplay.tsx and',
				'     receipt/receiptRows.tsx pass DEFAULT_CHAIN, not the row’s own chain. They will point',
				'     at Basescan for every chain. Thread the real chain through.',
				'',
				'See docs/superpowers/specs/2026-08-06-multichain-urls-design.md §2 and §3.',
			].join('\n'),
		).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/lib/chains.test.ts
```

Expected: FAIL — `Failed to resolve import "./chains"`.

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/lib/chains.ts`:

```ts
/**
 * The chains this app can address.
 *
 * Exactly one entry today, and two things depend on that being true — see the
 * tripwire test in chains.test.ts, which fails the moment CHAINS grows and
 * names both debts that come due at that point.
 *
 * Kept free of imports on purpose: 'use client' components import this module,
 * so it must never reach for the database, next/headers, or a node builtin.
 */
export interface Chain {
	readonly id: number;
	readonly slug: string;
	readonly name: string;
	readonly explorer: string;
}

export const CHAINS: readonly Chain[] = [
	{ id: 8453, slug: 'base', name: 'Base', explorer: 'https://basescan.org' },
];

export const DEFAULT_CHAIN: Chain = CHAINS[0]!;

export function chainById(id: number): Chain | null {
	return CHAINS.find((c) => c.id === id) ?? null;
}

/**
 * Resolves a URL chain segment, accepting the canonical slug ('base') or the
 * numeric id ('8453').
 *
 * `canonical` is false for anything the caller should redirect away from — the
 * numeric alias, or a slug in the wrong case. Returning the chain alongside
 * that flag is what lets the caller correct chain and hash in ONE redirect
 * rather than bouncing the browser twice.
 */
export function resolveChainParam(param: string): { chain: Chain; canonical: boolean } | null {
	const bySlug = CHAINS.find((c) => c.slug === param.toLowerCase());
	if (bySlug) return { chain: bySlug, canonical: param === bySlug.slug };

	// Decimal only: a hex id would be a second spelling of the same value, and
	// the API contract takes a JSON number.
	if (/^\d+$/.test(param)) {
		const byId = chainById(Number(param));
		if (byId) return { chain: byId, canonical: false };
	}
	return null;
}

export function explorerTx(chain: Chain, hash: string): string {
	return `${chain.explorer}/tx/${hash}`;
}

export function explorerAddress(chain: Chain, address: string): string {
	return `${chain.explorer}/address/${address}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/dashboard/lib/chains.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the tripwire actually trips (mutation check)**

Temporarily add a second entry to `CHAINS`:

```ts
export const CHAINS: readonly Chain[] = [
	{ id: 8453, slug: 'base', name: 'Base', explorer: 'https://basescan.org' },
	{ id: 42161, slug: 'arbitrum', name: 'Arbitrum', explorer: 'https://arbiscan.io' },
];
```

Run `npx vitest run packages/dashboard/lib/chains.test.ts`. Expected: the tripwire FAILS and prints the two-debt message. Also confirm `resolveChainParam('arbitrum')` now fails its rejection test — proving that test was reading the registry rather than a hardcoded null.

**Revert both lines** before continuing. A tripwire that does not trip is worse than no tripwire.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/lib/chains.ts packages/dashboard/lib/chains.test.ts
git commit -m "feat(chains): add the chain registry with a single-chain tripwire

One dependency-free module owning slug, id, display name and explorer host.
The tripwire test fails the moment a second chain is added and names the two
things that are silently wrong at that point: the chain-blind receipt query
and the 8 explorer links that pass DEFAULT_CHAIN.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Pure URL resolver

**Files:**
- Create: `packages/dashboard/lib/receiptUrl.ts`
- Test: `packages/dashboard/lib/receiptUrl.test.ts`

**Interfaces:**
- Consumes: `Chain`, `DEFAULT_CHAIN`, `resolveChainParam` from `./chains` (Task 1).
- Produces:
  - `const HASH_RE: RegExp`
  - `receiptPath(chain: Chain, hash: string): string`
  - `type ReceiptUrlResolution = { kind: 'render'; chain: Chain; hash: string } | { kind: 'redirect'; to: string } | { kind: 'notFound' }`
  - `resolveReceiptUrl(chainParam: string, hashParam: string): ReceiptUrlResolution`
  - `legacyReceiptRedirect(tx: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/lib/receiptUrl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAIN } from './chains';
import { legacyReceiptRedirect, receiptPath, resolveReceiptUrl } from './receiptUrl';

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

describe('receiptPath', () => {
	it('builds the canonical path and lowercases the hash', () => {
		expect(receiptPath(DEFAULT_CHAIN, HASH)).toBe(`/tx/base/${HASH}`);
		expect(receiptPath(DEFAULT_CHAIN, MIXED)).toBe(`/tx/base/${HASH}`);
	});

	// Callers hand this raw user input (a pasted value that was never validated),
	// so a segment that could break out of the path must not.
	it('escapes a segment that is not a hash', () => {
		expect(receiptPath(DEFAULT_CHAIN, 'a/b?c')).toBe('/tx/base/a%2Fb%3Fc');
	});
});

describe('resolveReceiptUrl', () => {
	it('renders a fully canonical URL', () => {
		expect(resolveReceiptUrl('base', HASH)).toEqual({
			kind: 'render',
			chain: DEFAULT_CHAIN,
			hash: HASH,
		});
	});

	it('redirects a mixed-case hash', () => {
		expect(resolveReceiptUrl('base', MIXED)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	it('redirects the numeric chain alias', () => {
		expect(resolveReceiptUrl('8453', HASH)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	it('redirects a mis-cased slug', () => {
		expect(resolveReceiptUrl('BASE', HASH)).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
	});

	// The whole point of resolving chain and hash together: a request wrong on
	// BOTH axes reaches the canonical URL in one hop, not two.
	it('corrects chain alias and hash casing in a SINGLE hop', () => {
		const result = resolveReceiptUrl('8453', MIXED);
		expect(result).toEqual({ kind: 'redirect', to: `/tx/base/${HASH}` });
		// Feeding the target back in must render, not redirect again.
		expect(resolveReceiptUrl('base', HASH).kind).toBe('render');
	});

	it('404s an unregistered chain', () => {
		expect(resolveReceiptUrl('arbitrum', HASH)).toEqual({ kind: 'notFound' });
	});

	it.each([
		['too short', '0x' + 'a'.repeat(63)],
		['too long', '0x' + 'a'.repeat(65)],
		['not hex', '0x' + 'z'.repeat(64)],
		['no 0x prefix', 'a'.repeat(64)],
		['empty', ''],
	])('404s a malformed hash (%s)', (_label, bad) => {
		expect(resolveReceiptUrl('base', bad)).toEqual({ kind: 'notFound' });
	});

	// Chain is checked first, so a request wrong on both axes costs one lookup.
	it('404s when both segments are bad', () => {
		expect(resolveReceiptUrl('arbitrum', 'nonsense')).toEqual({ kind: 'notFound' });
	});
});

describe('legacyReceiptRedirect', () => {
	it('sends a legacy ?tx= link to the default chain', () => {
		expect(legacyReceiptRedirect(HASH)).toBe(`/tx/base/${HASH}`);
	});

	it('lowercases and trims', () => {
		expect(legacyReceiptRedirect(`  ${MIXED}  `)).toBe(`/tx/base/${HASH}`);
	});

	// Redirecting garbage would turn a soft empty-search state into a hard 404.
	it('returns null for a malformed hash rather than redirecting to a 404', () => {
		expect(legacyReceiptRedirect('nonsense')).toBeNull();
		expect(legacyReceiptRedirect('')).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/lib/receiptUrl.test.ts
```

Expected: FAIL — `Failed to resolve import "./receiptUrl"`.

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/lib/receiptUrl.ts`:

```ts
import { DEFAULT_CHAIN, resolveChainParam, type Chain } from './chains';

/**
 * URL policy for receipts, kept pure and free of Next imports so the whole
 * canonicalization matrix is testable without standing up a request — the same
 * split as middleware.ts / lib/accessDecision.ts.
 */

export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The canonical path for a receipt.
 *
 * encodeURIComponent is a no-op on a valid hash (hex and '0x' are all
 * unreserved), and it is here for the callers that pass unvalidated user input:
 * a pasted value containing '/' or '?' becomes a safe 404 instead of escaping
 * the path segment.
 */
export function receiptPath(chain: Chain, hash: string): string {
	return `/tx/${chain.slug}/${encodeURIComponent(hash.toLowerCase())}`;
}

export type ReceiptUrlResolution =
	| { kind: 'render'; chain: Chain; hash: string }
	| { kind: 'redirect'; to: string }
	| { kind: 'notFound' };

/**
 * Decides what a `/tx/<chain>/<hash>` request should do.
 *
 * Chain and hash are normalized TOGETHER and produce at most one redirect. A
 * request that is non-canonical on both axes (say `/tx/8453/0xABC…`) must not
 * bounce the browser twice.
 *
 * Both segments are validated before the caller spends anything — no database
 * read, no RPC call, no rate-limiter slot. A malformed URL costs one regex.
 */
export function resolveReceiptUrl(chainParam: string, hashParam: string): ReceiptUrlResolution {
	const resolved = resolveChainParam(chainParam);
	if (!resolved) return { kind: 'notFound' };
	if (!HASH_RE.test(hashParam)) return { kind: 'notFound' };

	if (!resolved.canonical || hashParam !== hashParam.toLowerCase()) {
		return { kind: 'redirect', to: receiptPath(resolved.chain, hashParam) };
	}
	return { kind: 'render', chain: resolved.chain, hash: hashParam };
}

/**
 * Where a legacy `/?tx=…` link should land, or null if it cannot be
 * canonicalized.
 *
 * Null rather than a redirect for a malformed hash: the index answers that with
 * its empty search box, which is a better answer than a 404 for someone who
 * pasted badly.
 */
export function legacyReceiptRedirect(tx: string): string | null {
	const trimmed = tx.trim();
	if (!HASH_RE.test(trimmed)) return null;
	return receiptPath(DEFAULT_CHAIN, trimmed);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/dashboard/lib/receiptUrl.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Verify the single-hop test is not vacuous (mutation check)**

Temporarily break the one-hop guarantee by making the chain alias redirect without normalizing the hash:

```ts
	if (!resolved.canonical || hashParam !== hashParam.toLowerCase()) {
		return { kind: 'redirect', to: `/tx/${resolved.chain.slug}/${hashParam}` };
	}
```

Run the test file. Expected: **"corrects chain alias and hash casing in a SINGLE hop" FAILS** (the target still carries the uppercase hash), and so does "redirects a mixed-case hash". If either still passes, the assertion is not testing what it claims.

**Revert** the mutation.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/lib/receiptUrl.ts packages/dashboard/lib/receiptUrl.test.ts
git commit -m "feat(urls): add the pure receipt-URL resolver

Turns URL segments into render / redirect / notFound with no Next or React
involvement, so the full canonicalization matrix is unit-testable without a
request. Chain and hash normalize together, guaranteeing one redirect hop.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Data seam

**Files:**
- Create: `packages/dashboard/lib/loadReceipt.ts`
- Test: `packages/dashboard/lib/loadReceipt.test.ts`

**Interfaces:**
- Consumes: `Chain` from `./chains` (Task 1); `getReceiptByHash`, `ReceiptRow` from `./queries` (existing, `lib/queries.ts:39`).
- Produces: `loadReceipt(chain: Chain, hash: string): Promise<ReceiptRow | null>`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/lib/loadReceipt.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./queries', () => ({ getReceiptByHash: vi.fn(async () => null) }));

const { getReceiptByHash } = await import('./queries');
const { loadReceipt } = await import('./loadReceipt');
const { DEFAULT_CHAIN } = await import('./chains');

const mockGet = vi.mocked(getReceiptByHash);

beforeEach(() => {
	vi.clearAllMocks();
});

const HASH = '0x' + 'a'.repeat(64);

describe('loadReceipt', () => {
	it('passes the hash through to the query', async () => {
		await loadReceipt(DEFAULT_CHAIN, HASH);
		expect(mockGet).toHaveBeenCalledWith(HASH);
	});

	it('returns the row it finds', async () => {
		const row = { id: 1, txHash: HASH, chainId: 8453 };
		mockGet.mockResolvedValueOnce(row as never);
		await expect(loadReceipt(DEFAULT_CHAIN, HASH)).resolves.toBe(row);
	});

	it('returns null on a miss', async () => {
		await expect(loadReceipt(DEFAULT_CHAIN, HASH)).resolves.toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/lib/loadReceipt.test.ts
```

Expected: FAIL — `Failed to resolve import "./loadReceipt"`.

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/lib/loadReceipt.ts`:

```ts
import { getReceiptByHash, type ReceiptRow } from './queries';
import type { Chain } from './chains';

/**
 * The single place the receipt route gets its data.
 *
 * `chain` is accepted but deliberately unused. getReceiptByHash matches on
 * transaction hash alone and ignores chain_id, which is safe ONLY because
 * lib/chains.ts registers exactly one chain — so every URL that resolves at all
 * resolves to Base and there is no second row to confuse it with. The tripwire
 * test in chains.test.ts is what stops that assumption expiring quietly.
 *
 * The parameter is in the signature now because the database removal that
 * follows replaces this body with an on-demand analyzeTransaction(hash,
 * chain.id) call. Fixing the shape here means that change edits one function
 * rather than one function and every caller.
 */
export async function loadReceipt(chain: Chain, hash: string): Promise<ReceiptRow | null> {
	void chain;
	return getReceiptByHash(hash);
}
```

`void chain;` matches the existing convention for a deliberately-unused parameter — see `packages/core/src/classifyTransaction.ts:20`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/dashboard/lib/loadReceipt.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/lib/loadReceipt.ts packages/dashboard/lib/loadReceipt.test.ts
git commit -m "feat(receipts): add the loadReceipt seam

One function between the route and the data layer. Takes the chain it does
not yet need, so the database removal replaces a body instead of a signature
plus every call site.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The `/tx/[chain]/[hash]` route

**Files:**
- Create: `packages/dashboard/app/tx/[chain]/[hash]/page.tsx`
- Test: `packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx`
- Modify: `packages/dashboard/lib/accessDecision.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `resolveReceiptUrl` from `lib/receiptUrl` (Task 2); `loadReceipt` from `lib/loadReceipt` (Task 3); existing `ReceiptView` (`components/receiptView.tsx`), `createRateLimiter`/`createMemoryStore`/`clientKeyFromHeaders` (`lib/rateLimit.ts`), `classifyTransaction` (`@fabric-tca/core`).
- Produces: the route itself. Nothing imports it.

Note the import depth: from `app/tx/[chain]/[hash]/` the dashboard root is **four** levels up (`../../../../`).

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.React = React;

// notFound() and permanentRedirect() really do throw in Next, and the page
// relies on that to stop executing. Sentinel throws preserve that control flow
// so a test cannot accidentally pass by falling through to the render.
class NotFoundError extends Error {}
class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

const notFound = vi.fn(() => {
	throw new NotFoundError('NEXT_NOT_FOUND');
});
const permanentRedirect = vi.fn((to: string) => {
	throw new RedirectError(to);
});

// useRouter is required, not optional: this page renders ReceiptView, which
// renders ReceiptSearch (components/receiptView.tsx:78), which calls
// useRouter(). Mocking next/navigation without it throws at render.
vi.mock('next/navigation', () => ({
	notFound,
	permanentRedirect,
	useRouter: () => ({ push: () => {} }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Map() }));
vi.mock('../../../../lib/loadReceipt', () => ({ loadReceipt: vi.fn(async () => null) }));
// Safe to stub wholesale: components import RUNTIME values only from
// '@fabric-tca/core/pure' (a different specifier). What they take from
// '@fabric-tca/core' is `import type` and erases at compile.
vi.mock('@fabric-tca/core', () => ({ classifyTransaction: vi.fn(async () => ({ reason: 'NOT_A_SWAP' })) }));

const { loadReceipt } = await import('../../../../lib/loadReceipt');
const { DEFAULT_CHAIN } = await import('../../../../lib/chains');
const { default: TxPage } = await import('./page');

const mockLoad = vi.mocked(loadReceipt);

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

const render = (chain: string, hash: string) =>
	TxPage({ params: Promise.resolve({ chain, hash }) });

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.TCA_RPC_URL;
});

describe('/tx/[chain]/[hash]', () => {
	it('renders a canonical URL without redirecting', async () => {
		const html = renderToStaticMarkup(await render('base', HASH));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(notFound).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('loads the receipt with the RESOLVED chain, not a hardcoded one', async () => {
		await render('base', HASH);
		expect(mockLoad).toHaveBeenCalledWith(DEFAULT_CHAIN, HASH);
	});

	it('308s the numeric alias and a mixed-case hash in one hop', async () => {
		await expect(render('8453', MIXED)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	it('404s an unregistered chain', async () => {
		await expect(render('arbitrum', HASH)).rejects.toBeInstanceOf(NotFoundError);
		expect(notFound).toHaveBeenCalled();
	});

	it('404s a malformed hash', async () => {
		await expect(render('base', 'nonsense')).rejects.toBeInstanceOf(NotFoundError);
	});

	// The rejection must be free. Spending a database read on a URL that cannot
	// name a transaction is the failure this ordering exists to prevent.
	it('rejects without touching the data layer', async () => {
		await expect(render('arbitrum', HASH)).rejects.toThrow();
		await expect(render('base', 'nonsense')).rejects.toThrow();
		expect(mockLoad).not.toHaveBeenCalled();
	});

	it('redirects without touching the data layer', async () => {
		await expect(render('8453', HASH)).rejects.toThrow();
		expect(mockLoad).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run "packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx"
```

Expected: FAIL — `Failed to resolve import "./page"`. (Quote the path: the brackets are shell globs.)

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/app/tx/[chain]/[hash]/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';
import { resolveReceiptUrl } from '../../../../lib/receiptUrl';
import { loadReceipt } from '../../../../lib/loadReceipt';
import { ReceiptView } from '../../../../components/receiptView';
import {
	clientKeyFromHeaders,
	createMemoryStore,
	createRateLimiter,
} from '../../../../lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * A miss spends RPC to diagnose WHY, and this is the cheapest path in the app
 * to trigger: a plain GET, so crawlers, link unfurlers and an <img> tag all
 * reach it with no JS and no CORS preflight. Cheaper per hit than a full
 * analysis (~1 call), so the ceiling is higher than the API's — but it is not
 * free and must not be unbounded.
 *
 * Moved here verbatim from app/page.tsx when receipts left the index. Same
 * limit, same window, same behaviour — only the address changed.
 */
const diagnosisLimiter = createRateLimiter(createMemoryStore(), {
	limit: Number(process.env.RATE_LIMIT_DIAGNOSIS_PER_MIN) || 30,
	windowMs: 60_000,
});

export default async function ReceiptPage({
	params,
}: {
	params: Promise<{ chain: string; hash: string }>;
}) {
	const { chain: chainParam, hash: hashParam } = await params;

	// Resolved BEFORE any data read, RPC call or limiter slot: a URL that cannot
	// name a transaction must cost one regex, not a query.
	const resolution = resolveReceiptUrl(chainParam, hashParam);
	if (resolution.kind === 'notFound') return notFound();
	if (resolution.kind === 'redirect') return permanentRedirect(resolution.to);

	const { chain, hash } = resolution;
	const receipt = await loadReceipt(chain, hash);

	// On a genuine miss, diagnose why rather than showing a bare empty state.
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null) {
		const rpcUrl = process.env.TCA_RPC_URL;
		const budget = await diagnosisLimiter(clientKeyFromHeaders(await headers()));
		if (!budget.allowed) {
			// Deliberately leave `diagnosis` unset rather than inventing a reason
			// code: every AnalyzeFailure value asserts something about the
			// transaction, and we have not looked at it.
			diagnosis = undefined;
		} else {
			diagnosis = rpcUrl
				? await classifyTransaction(hash, chain.id, { rpcUrl })
				: { reason: 'ANALYZE_ERROR' };
		}
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run "packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx"
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Pin the route as public**

`lib/accessDecision.ts:29` uses an explicit protected-list model in which **a route added later is public unless listed**. `/tx/…` being public is correct for a paste-a-hash tool, but right now it is public by omission. Append to `packages/dashboard/lib/accessDecision.test.ts`:

```ts
// /tx/<chain>/<hash> is public BY OMISSION — accessDecision.ts uses a protected
// list, so any new route is open unless named. Public is the intended policy
// for a paste-a-hash receipt tool; this test makes it a decision on the record
// rather than a default nobody chose.
describe('the receipt route is public', () => {
	const hash = '0x' + 'a'.repeat(64);

	it('allows GET /tx/base/<hash> with no session', () => {
		expect(
			decideAccess({
				pathname: `/tx/base/${hash}`,
				method: 'GET',
				configured: true,
				hasValidSession: false,
			}),
		).toBe('allow');
	});

	it('allows it even when the access gate is unconfigured', () => {
		expect(
			decideAccess({
				pathname: `/tx/base/${hash}`,
				method: 'GET',
				configured: false,
				hasValidSession: false,
			}),
		).toBe('allow');
	});
});
```

Check the top of the file first — if `decideAccess` and `describe`/`expect`/`it` are already imported, do not re-import them.

- [ ] **Step 6: Run the access tests**

```bash
npx vitest run packages/dashboard/lib/accessDecision.test.ts
```

Expected: PASS, including the two new cases.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add "packages/dashboard/app/tx" packages/dashboard/lib/accessDecision.test.ts
git commit -m "feat(routes): add /tx/[chain]/[hash] as the canonical receipt URL

Thin adapter over resolveReceiptUrl: notFound, one-hop permanentRedirect, or
render. Both URL segments are validated before any data read, RPC call or
limiter slot, so a malformed URL costs one regex.

The diagnosis limiter moves here from app/page.tsx unchanged — same limit,
same window, same behaviour, new address. Adds a test pinning the route as
public, which it currently is only by omission from the protected list.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Index becomes search-only

**Files:**
- Modify: `packages/dashboard/app/page.tsx` (full rewrite — it is 59 lines)
- Test: `packages/dashboard/app/page.test.tsx` (create)

**Interfaces:**
- Consumes: `legacyReceiptRedirect` from `lib/receiptUrl` (Task 2); existing `ReceiptView`.
- Produces: nothing importable.

**Depends on Task 4.** Landing this first would redirect every legacy link to a route that does not exist yet.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/app/page.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.React = React;

class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

const permanentRedirect = vi.fn((to: string) => {
	throw new RedirectError(to);
});

// useRouter is required, not optional — this page renders ReceiptView, which
// renders ReceiptSearch (components/receiptView.tsx:78), which calls it.
vi.mock('next/navigation', () => ({
	permanentRedirect,
	useRouter: () => ({ push: () => {} }),
}));

const { default: IndexPage } = await import('./page');

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

const render = (tx?: string) =>
	IndexPage({ searchParams: Promise.resolve(tx === undefined ? {} : { tx }) });

beforeEach(() => {
	vi.clearAllMocks();
});

describe('index page', () => {
	it('renders the empty search state with no ?tx', async () => {
		const html = renderToStaticMarkup(await render());
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('308s a legacy ?tx= link to the canonical path', async () => {
		await expect(render(HASH)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	it('lowercases the hash while redirecting', async () => {
		await expect(render(MIXED)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	// A 404 would be a worse answer than the search box for someone who pasted
	// badly, so a malformed ?tx renders the empty state instead of redirecting.
	it('renders the search box for a malformed ?tx instead of redirecting', async () => {
		const html = renderToStaticMarkup(await render('nonsense'));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('ignores an empty ?tx', async () => {
		const html = renderToStaticMarkup(await render('   '));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/dashboard/app/page.test.tsx
```

Expected: FAIL — the current page renders a receipt and never calls `permanentRedirect`, so the two redirect cases fail.

- [ ] **Step 3: Rewrite the page**

Replace the entire contents of `packages/dashboard/app/page.tsx`:

```tsx
import { permanentRedirect } from 'next/navigation';
import { legacyReceiptRedirect } from '../lib/receiptUrl';
import { ReceiptView } from '../components/receiptView';

export const dynamic = 'force-dynamic';

/**
 * The index is the search box and nothing else. Receipts live at
 * /tx/<chain>/<hash>.
 *
 * `?tx=` is still read, for ONE purpose: sending links shared before the move
 * to their canonical home. This page never renders a receipt from it. A
 * malformed hash is deliberately NOT redirected — the empty search box is a
 * better answer than a 404 for someone who pasted badly.
 */
export default async function IndexPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const tx = sp.tx?.trim();
	if (tx) {
		const canonical = legacyReceiptRedirect(tx);
		if (canonical) permanentRedirect(canonical);
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={null} hash="" />
		</div>
	);
}
```

This removes the `headers`, `getReceiptByHash`, `classifyTransaction`, `AnalyzeFailure` and `rateLimit` imports, the `DEFAULT_CHAIN_ID` constant, and the `diagnosisLimiter` — all of which now live in the `/tx` route from Task 4.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/dashboard/app/page.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the diagnosis limiter was moved, not duplicated**

```bash
grep -rn "diagnosisLimiter\|RATE_LIMIT_DIAGNOSIS_PER_MIN" packages/dashboard --include=*.tsx --include=*.ts | grep -v node_modules
```

Expected: hits **only** in `app/tx/[chain]/[hash]/page.tsx`. Two independent limiters would silently double the effective ceiling.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/app/page.tsx packages/dashboard/app/page.test.tsx
git commit -m "feat(routes): make the index search-only, 308 legacy ?tx= links

The index sheds the receipt render, the diagnosis limiter and
classifyTransaction — all now at /tx/[chain]/[hash]. It still reads ?tx= for
one reason: redirecting links shared before the move.

A malformed ?tx renders the empty search box rather than redirecting to a
404, which would be a worse answer than the box for a bad paste.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Link producers

**Files:**
- Modify: `packages/dashboard/components/receiptSearch.tsx:76`
- Modify: `packages/dashboard/components/tradesTable.tsx:362`
- Modify: `packages/dashboard/lib/alerts.ts:131`
- Modify: `packages/dashboard/lib/alerts.test.ts:171,182`
- Modify: `packages/dashboard/app/api/receipts/activityNotify.test.ts:83`

**Interfaces:**
- Consumes: `receiptPath` from `lib/receiptUrl` (Task 2); `DEFAULT_CHAIN`, `chainById` from `lib/chains` (Task 1).
- Produces: nothing new.

**Depends on Task 4.**

- [ ] **Step 1: Update the two failing assertions first**

In `packages/dashboard/lib/alerts.test.ts`, change both expectations (lines 171 and 182):

```ts
		expect(msg).toContain('https://app.test/tx/base/0xdead');
```
```ts
		expect(msg).toContain('https://app.test/tx/base/0xbeef');
```

In `packages/dashboard/app/api/receipts/activityNotify.test.ts` line 83:

```ts
		expect(events[0]!.text).toContain(`https://app.test/tx/base/${VALID_HASH}`);
```

`VALID_HASH` is `'0x' + 'a'.repeat(64)` — already lowercase, so `receiptPath` leaves it unchanged.

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run packages/dashboard/lib/alerts.test.ts packages/dashboard/app/api/receipts/activityNotify.test.ts
```

Expected: FAIL — the messages still contain `/?tx=`.

- [ ] **Step 3: Update the Slack message**

In `packages/dashboard/lib/alerts.ts`, add to the imports at the top of the file:

```ts
import { DEFAULT_CHAIN } from './chains';
import { receiptPath } from './receiptUrl';
```

Then replace the return at line 131:

```ts
	// DEFAULT_CHAIN rather than the row's own chain: ReceiptSummary is structural
	// and carries no chainId, and this message only ever fires for a receipt the
	// API just analyzed — which SUPPORTED_CHAIN_IDS constrains to Base.
	return `New receipt: ${pair}${via}${notional}${cost}\n${baseUrl}${receiptPath(DEFAULT_CHAIN, r.txHash)}`;
```

- [ ] **Step 4: Update the search navigation**

In `packages/dashboard/components/receiptSearch.tsx`, add to the imports:

```ts
import { DEFAULT_CHAIN } from '../lib/chains';
import { receiptPath } from '../lib/receiptUrl';
```

Replace line 76:

```ts
			router.push(receiptPath(DEFAULT_CHAIN, trimmed) as Route);
```

`receiptPath` escapes the segment, so the `encodeURIComponent` this replaces is not lost — an unvalidated paste still cannot break out of the path.

- [ ] **Step 5: Update the share path**

In `packages/dashboard/components/tradesTable.tsx`, add to the imports:

```ts
import { chainById } from '../lib/chains';
import { receiptPath } from '../lib/receiptUrl';
```

Replace line 362:

```tsx
					<Receipt
						row={row}
						{...(shareChain ? { sharePath: receiptPath(shareChain, row.txHash) } : {})}
						onClose={onClose}
						onDelete={handleDelete}
					/>
```

And immediately above the `return (` of that same component (the dialog whose body contains line 362), add:

```tsx
	// A row whose chain is not registered gets NO share path rather than a URL
	// naming the wrong chain. ShareButton's `path` is optional and falls back to
	// window.location.href (components/receipt/receiptDisplay.tsx:29).
	const shareChain = chainById(row.chainId);
```

- [ ] **Step 6: Run the updated tests**

```bash
npx vitest run packages/dashboard/lib/alerts.test.ts packages/dashboard/app/api/receipts/activityNotify.test.ts
```

Expected: PASS.

- [ ] **Step 7: Confirm no `/?tx=` producer survives**

```bash
grep -rn "?tx=" packages/dashboard --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: hits only in `app/page.tsx`'s comment and `app/page.test.tsx`. Any other hit is a link producer that was missed.

- [ ] **Step 8: Full suite, typecheck, lint, and commit**

```bash
npx vitest run && npx tsc --build && npm run lint
```

```bash
git add packages/dashboard/components/receiptSearch.tsx packages/dashboard/components/tradesTable.tsx packages/dashboard/lib/alerts.ts packages/dashboard/lib/alerts.test.ts packages/dashboard/app/api/receipts/activityNotify.test.ts
git commit -m "feat(links): point every receipt-URL producer at /tx/<chain>/<hash>

Search navigation, the History share button and the Slack activity message.
The share path derives its chain from the row and is omitted entirely when
that chain is unregistered, rather than sharing a URL naming the wrong one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Centralize the explorer literal

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx:159`
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx:330,344,632`
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx:220,246,412,491`

**Interfaces:**
- Consumes: `DEFAULT_CHAIN`, `explorerTx`, `explorerAddress` from `lib/chains` (Task 1).
- Produces: nothing new.

**This task must change no rendered output.** Every `href` stays byte-identical, which is why the 18 existing assertions on `basescan.org` are left untouched — they are the regression test for this task.

This does **not** make links chain-aware. All 8 sites sit in helpers and components that receive a bare address or a `RouteLeg` and have no chain in scope; threading one through would be the bulk of this work, spent to make a one-entry registry look general. Passing `DEFAULT_CHAIN` puts the host in one module and turns the remaining work into `grep DEFAULT_CHAIN`. The tripwire from Task 1 is what forces it when a second chain lands.

- [ ] **Step 1: Record the current assertion count**

```bash
grep -rn "basescan.org" packages/dashboard --include=*.tsx --include=*.ts | grep -v node_modules | grep "\.test\." | wc -l
```

Expected: `18`. This number must be unchanged at the end of the task.

- [ ] **Step 2: Update `receiptView.tsx`**

Add to the imports:

```ts
import { DEFAULT_CHAIN, explorerTx } from '../lib/chains';
```

Replace line 159:

```tsx
						href={explorerTx(DEFAULT_CHAIN, row.txHash)}
```

- [ ] **Step 3: Update `receipt/receiptDisplay.tsx`**

Add to the imports:

```ts
import { DEFAULT_CHAIN, explorerAddress } from '../../lib/chains';
```

Line 330 and line 344 (both inside `getPriceImpactRows`):

```ts
				href: explorerAddress(DEFAULT_CHAIN, legLinkAddress(leg)),
```
```ts
			href: explorerAddress(DEFAULT_CHAIN, legLinkAddress(leg)),
```

Line 632 (inside `getAggregatorFeeLines`):

```ts
		href: explorerAddress(DEFAULT_CHAIN, s.address),
```

Mind the indentation — the two `getPriceImpactRows` sites sit at different depths.

- [ ] **Step 4: Update `receipt/receiptRows.tsx`**

Add to the imports:

```ts
import { DEFAULT_CHAIN, explorerAddress } from '../../lib/chains';
```

Line 220 and line 246:

```tsx
			href={explorerAddress(DEFAULT_CHAIN, address)}
```
```tsx
					href={explorerAddress(DEFAULT_CHAIN, address)}
```

Line 412 (`LegRouterTag`):

```tsx
			href={explorerAddress(DEFAULT_CHAIN, router.address)}
```

Line 491:

```tsx
			href={explorerAddress(DEFAULT_CHAIN, legLinkAddress(leg))}
```

- [ ] **Step 5: Confirm no literal survives in source**

```bash
grep -rn "basescan.org" packages/dashboard --include=*.tsx --include=*.ts | grep -v node_modules | grep -v "\.test\."
```

Expected: **no output**. The only remaining match is the `explorer` value in `lib/chains.ts`, which this grep excludes by filename only if you also check:

```bash
grep -rn "basescan.org" packages/dashboard/lib/chains.ts
```

Expected: exactly one hit, the registry entry.

- [ ] **Step 6: Run the full suite — the 18 assertions are the proof**

```bash
npx vitest run
```

Expected: PASS with no test file edited in this task. If any `basescan.org` assertion fails, a substitution changed the rendered URL and must be corrected rather than the assertion updated.

- [ ] **Step 7: Confirm the assertion count is unchanged**

```bash
grep -rn "basescan.org" packages/dashboard --include=*.tsx --include=*.ts | grep -v node_modules | grep "\.test\." | wc -l
```

Expected: `18`, same as Step 1.

- [ ] **Step 8: Typecheck, lint, and commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receipt/receiptDisplay.tsx packages/dashboard/components/receipt/receiptRows.tsx
git commit -m "refactor(links): route the 8 explorer links through the chain registry

The basescan.org literal now lives in one module. Every rendered href is
byte-identical, so the 18 existing assertions are untouched and serve as the
regression test that nothing moved.

This does NOT make links chain-aware: all 8 sites take a bare address or a
RouteLeg with no chain in scope. Passing DEFAULT_CHAIN turns the remaining
work into a grep, and the tripwire in chains.test.ts forces it when a second
chain lands.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: API route reads the registry

**Files:**
- Modify: `packages/dashboard/app/api/receipts/route.ts:25,29`

**Interfaces:**
- Consumes: `CHAINS`, `DEFAULT_CHAIN` from `lib/chains` (Task 1).
- Produces: nothing new. **The JSON contract is unchanged** — `chainId` stays a number, validation and error text stay identical.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

```bash
npx vitest run packages/dashboard/app/api/receipts/route.test.ts
```

Expected: PASS. `route.test.ts:171-198` already covers the chainId contract: rejects `[1, 999999, -1, 0, 1.5]` with 400, accepts 8453, defaults to Base when omitted, and rejects before spending RPC. These are the tests this task must not break — no new ones are needed.

- [ ] **Step 2: Replace the constants**

In `packages/dashboard/app/api/receipts/route.ts`, add to the imports (this file uses `.js` specifiers for local modules — match that):

```ts
import { CHAINS, DEFAULT_CHAIN } from '../../../lib/chains.js';
```

Replace lines 25-29:

```ts
const DEFAULT_CHAIN_ID = DEFAULT_CHAIN.id;

// Core hardwires viem's `base` chain, so any other id would store Base data
// under a false chain label. Accept only what we actually analyze — which is
// now stated once, in lib/chains.ts, rather than duplicated here.
const SUPPORTED_CHAIN_IDS = new Set(CHAINS.map((c) => c.id));
```

Everything downstream (`route.ts:193-201`) is untouched: `SUPPORTED_CHAIN_IDS.has(chainId)` and the `[...SUPPORTED_CHAIN_IDS].join(', ')` error string both still work on a `Set<number>`.

- [ ] **Step 3: Run the API tests**

```bash
npx vitest run packages/dashboard/app/api/receipts/
```

Expected: PASS, unchanged. In particular the 400 error text must still read `Unsupported chainId. Supported: 8453.`

- [ ] **Step 4: Confirm no hardcoded chain id survives in the dashboard**

```bash
grep -rn "8453" packages/dashboard --include=*.ts --include=*.tsx | grep -v node_modules | grep -v "\.test\."
```

Expected: exactly one hit — the registry entry in `lib/chains.ts`.

- [ ] **Step 5: Full suite, typecheck, lint, and commit**

```bash
npx vitest run && npx tsc --build && npm run lint
```

```bash
git add packages/dashboard/app/api/receipts/route.ts
git commit -m "refactor(api): derive the chain constants from the registry

DEFAULT_CHAIN_ID and SUPPORTED_CHAIN_IDS now come from lib/chains.ts. The
JSON contract is unchanged — chainId is still a number, validation still runs
before any RPC, and the 400 text is byte-identical.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: End-to-end verification

**Files:** none modified. This task is a gate, not a change.

- [ ] **Step 1: Full suite from a clean environment**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all green. Record the count — memory says this number has been misquoted before, so read it rather than assuming it.

- [ ] **Step 2: Full suite with `.env` exported**

Some tests skip silently without RPC credentials, so both states must be checked (`source .env` does **not** export on its own):

```bash
set -a && source .env && set +a && npx vitest run 2>&1 | tail -20
```

Expected: all green, count ≥ the previous run.

- [ ] **Step 3: Typecheck and lint**

```bash
npx tsc --build && npm run lint
```

Expected: both clean. Lint is what fails the Railway deploy.

- [ ] **Step 4: Start the dev server**

```bash
npm run dev
```

Wait for `Ready`. Do **not** run `npm run build` while this is up.

- [ ] **Step 5: Walk the canonicalization matrix against the live server**

Use a hash that exists in the local database. Get one:

```bash
psql "$DATABASE_URL" -tAc "select tx_hash from receipts limit 1"
```

Then, with `H` set to that hash and `U` to its uppercase-hex form:

```bash
H=<hash-from-above>
U=$(printf '0x%s' "$(echo "${H#0x}" | tr 'a-f' 'A-F')")

# canonical → 200
curl -so /dev/null -w "canonical      %{http_code}\n" "http://localhost:3000/tx/base/$H"

# legacy query param → 308 to the canonical path
curl -sI "http://localhost:3000/?tx=$H"        | grep -iE '^(HTTP|location)'

# numeric alias → 308
curl -sI "http://localhost:3000/tx/8453/$H"    | grep -iE '^(HTTP|location)'

# mixed-case hash → 308 to the lowercase path
curl -sI "http://localhost:3000/tx/base/$U"    | grep -iE '^(HTTP|location)'

# BOTH wrong → ONE hop straight to canonical
curl -sI "http://localhost:3000/tx/8453/$U"    | grep -iE '^(HTTP|location)'

# unregistered chain → 404
curl -so /dev/null -w "bad chain      %{http_code}\n" "http://localhost:3000/tx/arbitrum/$H"

# malformed hash → 404
curl -so /dev/null -w "bad hash       %{http_code}\n" "http://localhost:3000/tx/base/nonsense"

# partial paths → 404
curl -so /dev/null -w "/tx            %{http_code}\n" "http://localhost:3000/tx"
curl -so /dev/null -w "/tx/base       %{http_code}\n" "http://localhost:3000/tx/base"

# bare index → 200, search box
curl -so /dev/null -w "index          %{http_code}\n" "http://localhost:3000/"
```

Expected: `200`, three `308`s each with `location: /tx/base/<lowercase hash>`, a fourth `308` going **directly** to `/tx/base/<lowercase hash>` (not to `/tx/base/<UPPERCASE>` or `/tx/8453/…`), four `404`s, and a final `200`.

- [ ] **Step 6: Confirm the redirect is genuinely one hop**

```bash
curl -s -o /dev/null -w "redirects: %{num_redirects}  final: %{url_effective}\n" -L "http://localhost:3000/tx/8453/$U"
```

Expected: `redirects: 1` and a final URL of `http://localhost:3000/tx/base/<lowercase hash>`. A `2` here means chain and hash are being corrected in separate passes — the exact defect Task 2's mutation check guards against.

- [ ] **Step 7: Browser check**

Open `http://localhost:3000/tx/base/$H`. Confirm:
- the receipt renders with its content intact
- the transaction hash at the top links to `basescan.org/tx/<hash>`
- venue and address links in the body still resolve to `basescan.org/address/…`
- the Share button copies the `/tx/base/<hash>` URL, not `/?tx=`

Then open `http://localhost:3000/`, paste a hash into the search box, and confirm it navigates to `/tx/base/<hash>`.

- [ ] **Step 8: Commit nothing, report**

This task produces no diff. Report the test count from Steps 1-2 and any matrix cell that did not match.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 route shape, page responsibilities | 4, 5 |
| §1 canonicalization table (incl. slug casing, partial paths) | 2 (unit), 9 (live) |
| §1 validate-before-spending | 2, 4 (step 1 test), 9 |
| §2 registry module + placement + no-imports rule | 1 |
| §2 explorer literal centralized with `DEFAULT_CHAIN` | 7 |
| §2 absorbs `DEFAULT_CHAIN_ID` / `SUPPORTED_CHAIN_IDS` | 8 |
| §3 `loadReceipt` seam taking an unused `chain` | 3 |
| §3 unscoped read left alone, guarded by tripwire | 1 (tripwire), 3 (comment) |
| §4 link producers + updated assertions | 6 |
| §4 `sharePath` omitted for unregistered chain | 6 |
| §4 search flow otherwise unchanged | 6 (step 4 keeps the POST) |
| §5 access pinned public | 4 (steps 5-6) |
| §5 limiter moved not duplicated | 5 (step 5) |
| §6 tripwire naming both debts | 1 |
| §6 mutation verification | 1 (step 5), 2 (step 5) |
| §6 18 assertions untouched as regression proof | 7 (steps 1, 6, 7) |
| §7 manual verification | 9 |

No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries the literal code. No "similar to Task N" — the repeated `explorerAddress` substitutions in Task 7 are written out per line.

**Type consistency:** `Chain`, `CHAINS`, `DEFAULT_CHAIN`, `chainById`, `resolveChainParam`, `explorerTx`, `explorerAddress` (Task 1) are used with those exact names in Tasks 2, 3, 6, 7, 8. `receiptPath`, `resolveReceiptUrl`, `legacyReceiptRedirect`, `ReceiptUrlResolution` (Task 2) are used with those names in Tasks 4, 5, 6. `loadReceipt(chain, hash)` (Task 3) is called with that signature in Task 4 and mocked with it in Task 4's test. `resolveChainParam` returns `{ chain, canonical }` in Task 1 and is destructured as such in Task 2.
