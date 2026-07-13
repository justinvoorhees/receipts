# Granular Receipt Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "Transaction not found." state with a targeted set of distinguishable failure reasons — including a Relay/third-party trade whose EOA beneficiary we detect and name — rendered as a diagnostic card in the receipt panel.

**Architecture:** A pure net-flow classifier in core (`findCleanSwapCandidates` + `selectBeneficiary`) built on a shared `perAddressTokenDeltas` helper that `extractEndpoints` is refactored to reuse. An RPC wrapper `classifyTransaction` adds the EOA check (`getBytecode`) and best-effort symbol resolution. The receipts page classifies on a DB miss and passes a `diagnosis` to `ReceiptView`, which renders a `DiagnosticCard`.

**Tech Stack:** TypeScript, viem (Base RPC), Next.js App Router (server components), Vitest.

## Global Constraints

- Chain is Base, chainId `8453`. RPC from `process.env.TCA_RPC_URL`.
- Native ETH is the sentinel token string `'native'` (matches `endpoints.ts`).
- Core stays presentation-free: it emits machine `reason` + `detail` only; all human-facing copy lives dashboard-side.
- EOA test: `code` is empty (`undefined`, `'0x'`, or `''`) ⇒ EOA.
- Reason codes (closed set): `INVALID_HASH`, `NOT_FOUND_ONCHAIN`, `RELAYER_THIRD_PARTY`, `NOT_DECODABLE`, `ANALYZE_ERROR`.
- Failures are NOT persisted (no DB writes for un-decodable txns).
- Test runner: `npx vitest run <path>` from repo root. RPC e2e tests must `import 'dotenv/config'` and skip when `TCA_RPC_URL` is unset (mirror `packages/core/src/analyzeTransaction.test.ts`).
- Commit after each task's tests pass. Branch already exists: `feat/granular-receipt-errors`.

---

### Task 1: Shared per-address delta helper + refactor `extractEndpoints`

Extract the delta math so the classifier and `extractEndpoints` share one implementation.

**Files:**
- Modify: `packages/core/src/endpoints.ts`
- Test: `packages/core/src/endpoints.test.ts`

**Interfaces:**
- Consumes: `decodeTransferLogs`, `collectNativeEthDeltas` from `./tradeEndpoints.js` (existing); `TraceNode`, `Endpoints` (existing in `endpoints.ts`).
- Produces:
  - `perAddressTokenDeltas(trace: TraceNode): Map<string, Map<string, bigint>>` — lowercased address → (lowercased token or `'native'` → signed net).
  - `cleanSwapFromNets(nets: Map<string, bigint>): { inputToken: string; outputToken: string; inputAmountRaw: bigint; outputAmountRaw: bigint } | null` — the 1-neg/1-pos predicate.
  - `extractEndpoints` unchanged in signature/behavior, now implemented via the two helpers.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/endpoints.test.ts`:

```ts
import { perAddressTokenDeltas, cleanSwapFromNets } from './endpoints.js';

// Minimal callTracer log helper: an ERC-20 Transfer(from,to,value).
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
function transferLog(token: string, from: string, to: string, value: bigint) {
	return { address: token, data: word(value), topics: [TRANSFER, pad(from), pad(to)] };
}

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const P = '0x' + 'c'.repeat(40); // pool
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';

describe('perAddressTokenDeltas', () => {
	it('sums signed per-address token deltas across a trace', () => {
		const trace = {
			logs: [transferLog(WETH, A, P, 100n), transferLog(USDC, P, A, 250n)],
			calls: [],
		} as never;
		const per = perAddressTokenDeltas(trace);
		expect(per.get(A.toLowerCase())!.get(WETH)).toBe(-100n);
		expect(per.get(A.toLowerCase())!.get(USDC)).toBe(250n);
		expect(per.get(P.toLowerCase())!.get(WETH)).toBe(100n);
		expect(per.get(P.toLowerCase())!.get(USDC)).toBe(-250n);
	});
});

describe('cleanSwapFromNets', () => {
	it('returns input=negative leg, output=positive leg for a clean 1-in/1-out', () => {
		const nets = new Map<string, bigint>([[WETH, -100n], [USDC, 250n]]);
		expect(cleanSwapFromNets(nets)).toEqual({
			inputToken: WETH, outputToken: USDC, inputAmountRaw: 100n, outputAmountRaw: 250n,
		});
	});
	it('ignores zero-net tokens', () => {
		const nets = new Map<string, bigint>([[WETH, -100n], [USDC, 250n], ['0xdead', 0n]]);
		expect(cleanSwapFromNets(nets)?.inputToken).toBe(WETH);
	});
	it('returns null when not exactly 1 negative and 1 positive', () => {
		expect(cleanSwapFromNets(new Map([[WETH, -100n]]))).toBeNull();
		expect(cleanSwapFromNets(new Map([[WETH, -1n], [USDC, -2n], ['0xx', 3n]]))).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: FAIL — `perAddressTokenDeltas`/`cleanSwapFromNets` are not exported.

- [ ] **Step 3: Implement the helpers and refactor `extractEndpoints`**

In `packages/core/src/endpoints.ts`, add the two exports and re-point `extractEndpoints` at them. Replace the body of `extractEndpoints` and add the helpers:

```ts
const NATIVE = 'native';

/** address (lowercased) → (token or 'native' → signed net). */
export function perAddressTokenDeltas(trace: TraceNode): Map<string, Map<string, bigint>> {
	const per = new Map<string, Map<string, bigint>>();
	const bump = (addr: string, token: string, v: bigint) => {
		const a = addr.toLowerCase();
		const m = per.get(a) ?? new Map<string, bigint>();
		m.set(token, (m.get(token) ?? 0n) + v);
		per.set(a, m);
	};
	const logs = collectTraceLogs(trace);
	for (const t of decodeTransferLogs(logs as never)) {
		const token = t.token.toLowerCase();
		bump(t.from, token, -t.value);
		bump(t.to, token, t.value);
	}
	for (const [addr, v] of collectNativeEthDeltas(trace as never)) {
		if (v !== 0n) bump(addr, NATIVE, v);
	}
	return per;
}

/** The clean 1-in/1-out predicate over a single address's net map. */
export function cleanSwapFromNets(
	nets: Map<string, bigint>,
): { inputToken: string; outputToken: string; inputAmountRaw: bigint; outputAmountRaw: bigint } | null {
	const nonzero = [...nets.entries()].filter(([, v]) => v !== 0n);
	const negatives = nonzero.filter(([, v]) => v < 0n);
	const positives = nonzero.filter(([, v]) => v > 0n);
	if (negatives.length !== 1 || positives.length !== 1) return null;
	const [inputToken, inputNet] = negatives[0]!;
	const [outputToken, outputNet] = positives[0]!;
	return { inputToken, outputToken, inputAmountRaw: -inputNet, outputAmountRaw: outputNet };
}

export function extractEndpoints(args: { trace: TraceNode; trader: string }): Endpoints | null {
	const trader = args.trader.toLowerCase();
	const nets = perAddressTokenDeltas(args.trace).get(trader) ?? new Map<string, bigint>();
	const swap = cleanSwapFromNets(nets);
	if (!swap) return null;
	return { trader, ...swap };
}
```

Keep the existing `collectTraceLogs` private function and the `import` of `collectNativeEthDeltas, decodeTransferLogs`. Remove the now-dead inline net-summing that used to live in `extractEndpoints`.

- [ ] **Step 4: Run tests to verify pass (new + existing)**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: PASS — new helper tests pass AND all pre-existing `extractEndpoints` tests still pass (behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endpoints.ts packages/core/src/endpoints.test.ts
git commit -m "refactor(core): extract perAddressTokenDeltas + cleanSwapFromNets"
```

---

### Task 2: Pure classifier — `findCleanSwapCandidates` + `selectBeneficiary`

The crux of the feature, fully unit-tested without RPC.

**Files:**
- Modify: `packages/core/src/endpoints.ts` (add types + two pure functions)
- Test: `packages/core/src/endpoints.test.ts`

**Interfaces:**
- Consumes: `perAddressTokenDeltas`, `cleanSwapFromNets`, `TraceNode` (Task 1).
- Produces:
  - `FailureReason`, `RelayerDetail`, `AnalyzeFailure`, `CleanSwap` types.
  - `findCleanSwapCandidates(trace: TraceNode, trader: string): CleanSwap[]`
  - `selectBeneficiary(candidates: CleanSwap[], trader: string, isEoa: (address: string) => boolean): RelayerDetail | null`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/endpoints.test.ts` (reuses `transferLog`, `A`, `B`, `P`, `USDC`, `WETH` from Task 1):

```ts
import { findCleanSwapCandidates, selectBeneficiary, type CleanSwap } from './endpoints.js';

const RELAYER = '0x' + 'f'.repeat(40); // tx.from, nets nothing

describe('findCleanSwapCandidates', () => {
	it('finds beneficiary + counterparty; relayer (net zero) absent', () => {
		// A = beneficiary: WETH out(-100), USDC in(+250). P = counterparty: mirror.
		const trace = {
			logs: [transferLog(WETH, A, P, 100n), transferLog(USDC, P, A, 250n)],
			calls: [],
		} as never;
		const cands = findCleanSwapCandidates(trace, RELAYER);
		const addrs = cands.map((c) => c.address).sort();
		expect(addrs).toEqual([A.toLowerCase(), P.toLowerCase()].sort());
	});

	it('returns [] for a non-swap (single one-sided transfer)', () => {
		const trace = { logs: [transferLog(USDC, A, B, 50n)], calls: [] } as never;
		expect(findCleanSwapCandidates(trace, RELAYER)).toEqual([]);
	});
});

describe('selectBeneficiary', () => {
	const eoaAddr = A.toLowerCase();
	const contractAddr = P.toLowerCase();
	const candA: CleanSwap = { address: eoaAddr, inputToken: USDC, outputToken: 'native', inputAmountRaw: 1n, outputAmountRaw: 2n };
	const candP: CleanSwap = { address: contractAddr, inputToken: WETH, outputToken: USDC, inputAmountRaw: 3n, outputAmountRaw: 4n };

	it('prefers the sole EOA among candidates', () => {
		const isEoa = (a: string) => a === eoaAddr;
		expect(selectBeneficiary([candA, candP], RELAYER, isEoa)).toEqual({
			beneficiary: eoaAddr, inputToken: USDC, outputToken: 'native',
		});
	});

	it('falls back to the sole candidate when none are EOA (AA wallet)', () => {
		expect(selectBeneficiary([candP], RELAYER, () => false)).toEqual({
			beneficiary: contractAddr, inputToken: WETH, outputToken: USDC,
		});
	});

	it('returns null when two EOAs are ambiguous', () => {
		expect(selectBeneficiary([candA, candP], RELAYER, () => true)).toBeNull();
	});

	it('returns null for empty candidates', () => {
		expect(selectBeneficiary([], RELAYER, () => true)).toBeNull();
	});

	it('excludes the trader from selection', () => {
		const traderCand: CleanSwap = { ...candA, address: RELAYER.toLowerCase() };
		expect(selectBeneficiary([traderCand], RELAYER, () => true)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: FAIL — `findCleanSwapCandidates`/`selectBeneficiary` not exported.

- [ ] **Step 3: Implement types + functions**

Add to `packages/core/src/endpoints.ts`:

```ts
export type FailureReason =
	| 'INVALID_HASH'
	| 'NOT_FOUND_ONCHAIN'
	| 'RELAYER_THIRD_PARTY'
	| 'NOT_DECODABLE'
	| 'ANALYZE_ERROR';

export interface RelayerDetail {
	beneficiary: string;
	inputToken: string;
	outputToken: string;
	inputSymbol?: string;
	outputSymbol?: string;
}

export interface AnalyzeFailure {
	reason: FailureReason;
	detail?: RelayerDetail;
}

export interface CleanSwap {
	address: string;
	inputToken: string;
	outputToken: string;
	inputAmountRaw: bigint;
	outputAmountRaw: bigint;
}

/** Every address whose net delta is a clean 1-in/1-out (includes `trader` if it qualifies). */
export function findCleanSwapCandidates(trace: TraceNode, trader: string): CleanSwap[] {
	void trader; // included for signature symmetry; trader filtering happens in selectBeneficiary
	const out: CleanSwap[] = [];
	for (const [address, nets] of perAddressTokenDeltas(trace)) {
		const swap = cleanSwapFromNets(nets);
		if (swap) out.push({ address, ...swap });
	}
	return out;
}

/** Pick the beneficiary: exclude trader, prefer the sole EOA, else the sole candidate. */
export function selectBeneficiary(
	candidates: CleanSwap[],
	trader: string,
	isEoa: (address: string) => boolean,
): RelayerDetail | null {
	const t = trader.toLowerCase();
	const pool = candidates.filter((c) => c.address.toLowerCase() !== t);
	const pick = (c: CleanSwap): RelayerDetail => ({
		beneficiary: c.address,
		inputToken: c.inputToken,
		outputToken: c.outputToken,
	});
	const eoas = pool.filter((c) => isEoa(c.address));
	if (eoas.length === 1) return pick(eoas[0]!);
	if (pool.length === 1) return pick(pool[0]!);
	return null;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endpoints.ts packages/core/src/endpoints.test.ts
git commit -m "feat(core): pure relayer classifier (candidates + EOA beneficiary select)"
```

---

### Task 3: RPC wrapper `classifyTransaction` + public export

Wire format-check → fetch → candidate scan → EOA check → symbol resolution.

**Files:**
- Create: `packages/core/src/classifyTransaction.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/classifyTransaction.test.ts`

**Interfaces:**
- Consumes: `findCleanSwapCandidates`, `selectBeneficiary`, `type AnalyzeFailure`, `type RelayerDetail`, `type TraceNode`, `extractEndpoints` (Task 2 / existing); `createDefaultPricingDeps` from `./pricing.js` (existing, has `readSymbol(token: string): Promise<string>`); viem `createPublicClient`, `http`, `base`.
- Produces: `classifyTransaction(hash: string, chainId: number, opts: { rpcUrl: string }): Promise<AnalyzeFailure>`, re-exported from `index.ts` along with the `AnalyzeFailure`/`RelayerDetail`/`FailureReason` types.

- [ ] **Step 1: Write the failing test (RPC e2e, gated)**

Create `packages/core/src/classifyTransaction.test.ts`:

```ts
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { classifyTransaction } from './classifyTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const d = RPC ? describe : describe.skip;

describe('classifyTransaction format check (no RPC)', () => {
	it('flags a malformed hash as INVALID_HASH', async () => {
		const r = await classifyTransaction('0x123', 8453, { rpcUrl: 'http://unused' });
		expect(r.reason).toBe('INVALID_HASH');
	});
});

d('classifyTransaction e2e', () => {
	it('classifies the Relay relayer trade with its EOA beneficiary', async () => {
		const r = await classifyTransaction(
			'0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r.reason).toBe('RELAYER_THIRD_PARTY');
		expect(r.detail?.beneficiary.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		// USDC in, native ETH out.
		expect(r.detail?.inputToken.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
		expect(r.detail?.outputToken).toBe('native');
	}, 60000);

	it('returns NOT_FOUND_ONCHAIN for a well-formed but absent hash', async () => {
		const r = await classifyTransaction('0x' + '0'.repeat(64), 8453, { rpcUrl: RPC! });
		expect(r.reason).toBe('NOT_FOUND_ONCHAIN');
	}, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/classifyTransaction.test.ts`
Expected: FAIL — module `./classifyTransaction.js` does not exist.

- [ ] **Step 3: Implement `classifyTransaction`**

Create `packages/core/src/classifyTransaction.ts`:

```ts
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import {
	extractEndpoints,
	findCleanSwapCandidates,
	selectBeneficiary,
	type AnalyzeFailure,
	type RelayerDetail,
	type TraceNode,
} from './endpoints.js';
import { createDefaultPricingDeps } from './pricing.js';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NATIVE = 'native';

/** Diagnose WHY analyzeTransaction could not produce a receipt for `hash`.
 *  Callers invoke this only on a known miss; a resolvable swap returns the
 *  defensive ANALYZE_ERROR fallback. Never throws. */
export async function classifyTransaction(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string },
): Promise<AnalyzeFailure> {
	void chainId;
	if (!HASH_RE.test(hash.trim())) return { reason: 'INVALID_HASH' };

	const rpc = createPublicClient({ chain: base, transport: http(opts.rpcUrl) });
	const txHash = hash.trim() as `0x${string}`;

	let tx;
	try {
		tx = await rpc.getTransaction({ hash: txHash });
	} catch {
		return { reason: 'NOT_FOUND_ONCHAIN' };
	}

	let trace: TraceNode;
	try {
		trace = (await (rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
			method: 'debug_traceTransaction',
			params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
		})) as TraceNode;
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}

	try {
		const trader = tx.from.toLowerCase();
		// Defensive: if endpoints actually resolve, this wasn't a real failure.
		if (extractEndpoints({ trace, trader })) return { reason: 'ANALYZE_ERROR' };

		const candidates = findCleanSwapCandidates(trace, trader);
		const addrs = [...new Set(candidates.map((c) => c.address.toLowerCase()))];
		const eoaFlags = new Map<string, boolean>();
		await Promise.all(
			addrs.map(async (a) => {
				try {
					const code = await rpc.getBytecode({ address: a as `0x${string}` });
					eoaFlags.set(a, !code || code === '0x');
				} catch {
					eoaFlags.set(a, false); // unknown → treat as contract (conservative)
				}
			}),
		);
		const detail = selectBeneficiary(candidates, trader, (a) => eoaFlags.get(a.toLowerCase()) ?? false);
		if (!detail) return { reason: 'NOT_DECODABLE' };

		// Best-effort symbols; unresolved omitted (UI falls back to short address).
		const readSymbol = createDefaultPricingDeps(opts.rpcUrl).readSymbol;
		const sym = async (token: string): Promise<string | undefined> => {
			if (token.toLowerCase() === NATIVE) return 'ETH';
			try {
				return await readSymbol(token);
			} catch {
				return undefined;
			}
		};
		const [inputSymbol, outputSymbol] = await Promise.all([sym(detail.inputToken), sym(detail.outputToken)]);
		const withSymbols: RelayerDetail = {
			...detail,
			...(inputSymbol ? { inputSymbol } : {}),
			...(outputSymbol ? { outputSymbol } : {}),
		};
		return { reason: 'RELAYER_THIRD_PARTY', detail: withSymbols };
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}
}
```

Then add to `packages/core/src/index.ts`:

```ts
export {
	classifyTransaction,
} from './classifyTransaction.js';
export type { AnalyzeFailure, RelayerDetail, FailureReason } from './endpoints.js';
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/core/src/classifyTransaction.test.ts`
Expected: PASS. (If `TCA_RPC_URL` is set, the e2e cases run and confirm beneficiary `0xf70da978…` + USDC→native; otherwise only the format-check test runs.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src/classifyTransaction.ts packages/core/src/classifyTransaction.test.ts packages/core/src/index.ts
git commit -m "feat(core): classifyTransaction — reason + EOA-beneficiary diagnosis"
```

---

### Task 4: `DiagnosticCard` component + copy map (dashboard)

Presentation for a failure, with reason→copy map and the relayer detail.

**Files:**
- Create: `packages/dashboard/components/DiagnosticCard.tsx`
- Test: `packages/dashboard/components/DiagnosticCard.test.tsx`

**Interfaces:**
- Consumes: `type AnalyzeFailure`, `type FailureReason` from `@fabric-tca/core` (Task 3); `shortTxHash` from `../lib/formatters` (existing, `(s: string) => string`, usable as an address shortener).
- Produces: `export function DiagnosticCard({ failure }: { failure: AnalyzeFailure }): JSX.Element` and `export const REASON_COPY: Record<FailureReason, { title: string; body: string }>`.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/components/DiagnosticCard.test.tsx` (mirror `ReceiptView.test.tsx`'s `renderToStaticMarkup` pattern):

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('DiagnosticCard', () => {
	it('renders title + body for a plain reason', async () => {
		const { DiagnosticCard } = await import('./DiagnosticCard');
		const html = renderToStaticMarkup(<DiagnosticCard failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);
		expect(html).toContain('Not found on Base');
		expect(html).toContain('No transaction with this hash exists on Base');
	});

	it('renders the beneficiary + pair for a relayer trade', async () => {
		const { DiagnosticCard } = await import('./DiagnosticCard');
		const html = renderToStaticMarkup(
			<DiagnosticCard
				failure={{
					reason: 'RELAYER_THIRD_PARTY',
					detail: {
						beneficiary: '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
						inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
						outputToken: 'native',
						inputSymbol: 'USDC',
						outputSymbol: 'ETH',
					},
				}}
			/>,
		);
		expect(html).toContain('Relay / third-party trade');
		expect(html).toContain('0xf70d'); // shortened beneficiary
		expect(html).toContain('USDC');
		expect(html).toContain('ETH');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/components/DiagnosticCard.test.tsx`
Expected: FAIL — module `./DiagnosticCard` does not exist.

- [ ] **Step 3: Implement the component + copy map**

Create `packages/dashboard/components/DiagnosticCard.tsx`:

```tsx
import type { AnalyzeFailure, FailureReason } from '@fabric-tca/core';
import { shortTxHash } from '../lib/formatters';

export const REASON_COPY: Record<FailureReason, { title: string; body: string }> = {
	INVALID_HASH: {
		title: 'Invalid transaction hash',
		body: 'That doesn’t look like a transaction hash — expected a 66-character 0x… value.',
	},
	NOT_FOUND_ONCHAIN: {
		title: 'Not found on Base',
		body: 'No transaction with this hash exists on Base (chain 8453). Check the hash and that it’s a Base transaction.',
	},
	RELAYER_THIRD_PARTY: {
		title: 'Relay / third-party trade',
		body: 'The sender relayed this swap on behalf of another address. Beneficiary-anchored decoding isn’t supported yet.',
	},
	NOT_DECODABLE: {
		title: 'Not a decodable swap',
		body: 'We couldn’t find a clean token-in / token-out swap for the sender. It may be a transfer, approval, LP action, or a multi-hop batch we don’t decompose yet.',
	},
	ANALYZE_ERROR: {
		title: 'Couldn’t analyze',
		body: 'Couldn’t analyze this transaction — try again.',
	},
};

export function DiagnosticCard({ failure }: { failure: AnalyzeFailure }) {
	const copy = REASON_COPY[failure.reason];
	const d = failure.detail;
	const pair =
		d && (d.inputSymbol || d.outputSymbol)
			? `${d.inputSymbol ?? shortTxHash(d.inputToken)} → ${d.outputSymbol ?? shortTxHash(d.outputToken)}`
			: null;

	return (
		<div
			className="flex flex-col gap-[12px] rounded-[2px] border p-[20px]"
			style={{ borderColor: 'var(--color-red)' }}
		>
			<span className="font-['Sohne_Breit'] text-[14px] leading-[16px]" style={{ color: 'var(--color-red)' }}>
				{copy.title}
			</span>
			<span className="font-['Sohne'] text-[13px] leading-[18px]" style={{ color: 'var(--color-secondary)' }}>
				{copy.body}
			</span>
			{failure.reason === 'RELAYER_THIRD_PARTY' && d && (
				<div className="flex flex-col gap-[4px] font-['Sohne_Mono'] text-[12px] leading-[16px]">
					<span style={{ color: 'var(--color-secondary)' }}>
						Swap executed for{' '}
						<span style={{ color: 'var(--color-primary)' }}>{shortTxHash(d.beneficiary)}</span>
					</span>
					{pair && <span style={{ color: 'var(--color-primary)' }}>{pair}</span>}
				</div>
			)}
		</div>
	);
}
```

Note: `shortTxHash` shortens any `0x…` string; reused as an address shortener (no new helper — DRY).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/dashboard/components/DiagnosticCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/DiagnosticCard.tsx packages/dashboard/components/DiagnosticCard.test.tsx
git commit -m "feat(dashboard): DiagnosticCard + reason copy map"
```

---

### Task 5: Plumbing — page classifies on miss; `ReceiptView` renders the card

Wire the diagnosis from the server render into the UI.

**Files:**
- Modify: `packages/dashboard/app/receipts/page.tsx`
- Modify: `packages/dashboard/components/ReceiptView.tsx:321-331`
- Test: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: `classifyTransaction`, `type AnalyzeFailure` from `@fabric-tca/core` (Task 3); `DiagnosticCard`, `REASON_COPY` from `./DiagnosticCard` (Task 4); existing `getReceiptByHash`, `ReceiptSearch`.
- Produces: `ReceiptView` accepting an optional `diagnosis?: AnalyzeFailure` prop.

- [ ] **Step 1: Write the failing test**

Add to `packages/dashboard/components/ReceiptView.test.tsx`:

```tsx
describe('ReceiptView diagnosis', () => {
	it('renders the DiagnosticCard when trade is null and a diagnosis is present', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={null} hash="0xabc" diagnosis={{ reason: 'NOT_DECODABLE' }} />,
		);
		expect(html).toContain('Not a decodable swap');
	});

	it('falls back to the field error when no diagnosis is supplied', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="0xabc" />);
		expect(html).toContain('Transaction not found.');
		expect(html).not.toContain('Not a decodable swap');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: FAIL — `ReceiptView` does not accept/render `diagnosis`.

- [ ] **Step 3: Update `ReceiptView`**

Replace the `ReceiptView` function in `packages/dashboard/components/ReceiptView.tsx` (currently lines 321–331):

```tsx
import type { AnalyzeFailure } from '@fabric-tca/core';
import { DiagnosticCard } from './DiagnosticCard';

export function ReceiptView({
	trade,
	hash,
	diagnosis,
}: {
	trade: ReceiptRow | null;
	hash: string;
	diagnosis?: AnalyzeFailure;
}) {
	// When a computed diagnosis exists, show its short title inline; otherwise the
	// legacy generic string. Only reached when trade is null.
	const error =
		trade === null
			? diagnosis
				? undefined // full detail rendered in the card below; keep the field red without duplicate text
				: 'Transaction not found.'
			: undefined;
	const fieldError = trade === null && diagnosis ? ' ' : error; // ' ' keeps the field red without text

	return (
		<div className="flex flex-col gap-[40px] pb-10">
			<ReceiptSearch hash={hash} {...(fieldError !== undefined ? { error: fieldError } : {})} />
			{trade != null && <Receipt row={trade} />}
			{trade == null && diagnosis && <DiagnosticCard failure={diagnosis} />}
		</div>
	);
}
```

Put the two new `import` lines at the top of the file with the other imports (not inside the function).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`
Expected: PASS (new cases + existing tests).

- [ ] **Step 5: Wire the page to classify on miss**

Replace `packages/dashboard/app/receipts/page.tsx` body:

```tsx
import { getReceiptByHash } from '../../lib/queries';
import { ReceiptView } from '../../components/ReceiptView';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';

export const dynamic = 'force-dynamic';

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';
const DEFAULT_CHAIN_ID = 8453;

export default async function ReceiptsPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const explicit = sp.tx != null && sp.tx.trim() !== '';
	const hash = (sp.tx ?? DEFAULT_HASH).trim();
	const receipt = await getReceiptByHash(hash);

	// On a genuine miss for an explicitly-pasted hash, diagnose WHY (page is the
	// single server render; successes are already persisted by the awaited POST).
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null && explicit) {
		const rpcUrl = process.env.TCA_RPC_URL;
		diagnosis = rpcUrl
			? await classifyTransaction(hash, DEFAULT_CHAIN_ID, { rpcUrl })
			: { reason: 'ANALYZE_ERROR' };
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />
		</div>
	);
}
```

- [ ] **Step 6: Verify build + typecheck**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run packages/dashboard packages/core`
Expected: PASS (all dashboard + core tests).

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/app/receipts/page.tsx packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): classify on DB miss and render DiagnosticCard"
```

---

## Verification (after all tasks)

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run` green across the repo.
- [ ] With `TCA_RPC_URL` exported, run the dev server (`npm run dev`) and paste `0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f` (after deleting receipts id 119 if still present) → the receipt panel shows the **Relay / third-party trade** card; the rendered short beneficiary is `0xf70d…` (from `0xf70da97812cb96acdf810712aa562db8dfa3dbef`), pair `USDC → ETH`.
- [ ] Paste a plain ERC-20 transfer hash → **Not a decodable swap**.
- [ ] Paste a malformed hash → **Invalid transaction hash** (no RPC call).

## Self-Review Notes

- Spec coverage: taxonomy (Task 4 copy map), detection incl. EOA selection (Tasks 1–3), plumbing Option A (Task 5), testing (each task's tests + final verification). ANALYZE_ERROR covered in `classifyTransaction` (trace failure / RPC-unset in page). Non-goals (no beneficiary decoding, no failure persistence) respected — the card states "isn’t supported yet" and no task writes failure rows.
- Type consistency: `AnalyzeFailure`/`RelayerDetail`/`FailureReason`/`CleanSwap` defined in Task 2, consumed unchanged in Tasks 3–5. `findCleanSwapCandidates`/`selectBeneficiary` signatures identical across definition and callers.
- Known stopgap row (receipts id 119) is addressed out-of-band (see conversation) — the final verification deletes it before the manual check so it doesn't mask the new path.
