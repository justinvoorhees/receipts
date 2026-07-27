# Per-Leg Router Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on each route leg of a receipt, which *other* aggregator's contract executed that leg — e.g. a Relay receipt whose legs were executed by Fabric.

**Architecture:** `analyzeTransaction` already fetches a `callTracer` trace with `withLog`. A new pure core module walks that trace and records, per venue address, the chain of enclosing `CALL` frame addresses — **raw addresses, no naming**. That chain is persisted into the existing `route_legs` jsonb. Names are resolved **on read**, server-side, against `configs/routers.json` / `configs/settlers.json`, so growing the registry retroactively lights up historical receipts with no repopulate. The dashboard renders the innermost known router in the leg's context slot, linked to Basescan, with the full path in a tooltip only when the chain is deeper than 2.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), viem, Vitest 2, Next.js App Router, Drizzle ORM, Tailwind utility classes inline.

**Spec:** `docs/superpowers/specs/2026-07-27-per-leg-router-attribution-design.md`

## Global Constraints

- **Zero new RPC calls.** The trace is already fetched at `analyzeTransaction.ts:199-206`. Do not add a second `debug_traceTransaction`.
- **No migration.** `route_legs` is already `jsonb` (`packages/db/src/schema.ts:69`). Do not run `db:generate`.
- **`legFrameChains.ts` must stay registry-free and RPC-free.** No `labelAddress`, no config reads, no naming. That purity is what makes attribution retroactive.
- **Only curated registries attribute.** A frame is a router iff `routers.json` / `settlers.json` know it. Never infer from `ContractName`, bytecode, or topics.
- **The tag means "executed by", never route authorship.** Frame nesting proves containment only.
- **Core is ESM with explicit extensions:** `import { x } from './y.js'` even though the source is `y.ts`.
- **Tabs for indentation.** Match surrounding files exactly.
- **`import type` for anything a client component may touch.** `lib/queries.ts` imports the fs-touching core barrel; every component importing from `lib/queries` must keep using `import type`.
- **Run the full suite, not a filtered subset.** `npx vitest run <name>` treats the arg as a substring filter and has historically produced inflated/false green counts. Use `npm test` for gates.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Branch:** `feat/per-leg-router-attribution` (already created; spec committed at `9471bda`).

---

### Task 1: Core — extract frame chains (pure)

**Files:**
- Create: `packages/core/src/legFrameChains.ts`
- Create: `packages/core/src/legFrameChains.test.ts`
- Modify: `packages/core/src/index.ts` (add export)

**Interfaces:**
- Consumes: `TraceNode` from `./tradeEndpoints.js` (re-exported by `./endpoints.js`).
- Produces: `extractFrameChains(trace: TraceNode, venues: ReadonlySet<string>): Map<string, string[]>` — venue address (lowercased) → enclosing `CALL` frame addresses, outermost→innermost, lowercased. Venues with ambiguous or empty chains are absent from the map.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/legFrameChains.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractFrameChains } from './legFrameChains.js';
import type { TraceNode } from './tradeEndpoints.js';

const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OUTER = '0xcccccccccccccccccccccccccccccccccccccccc';
const MID = '0xdddddddddddddddddddddddddddddddddddddddd';
const INNER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** A log emitted by `address`; topics are irrelevant — matching is by emitter. */
const log = (address: string) => ({
	address: address as `0x${string}`,
	data: '0x' as `0x${string}`,
	topics: [] as [],
});

const call = (to: string, extra: Partial<TraceNode> = {}): TraceNode => ({
	type: 'CALL',
	to: to as `0x${string}`,
	...extra,
});

describe('extractFrameChains', () => {
	it('records the enclosing CALL frames of a venue, outermost first', () => {
		const trace = call(OUTER, {
			calls: [call(MID, { calls: [call(POOL, { logs: [log(POOL)] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL]))).toEqual(
			new Map([[POOL, [OUTER, MID]]]),
		);
	});

	it('excludes the venue itself from its own chain', () => {
		const trace = call(OUTER, { calls: [call(POOL, { logs: [log(POOL)] })] });
		expect(extractFrameChains(trace, new Set([POOL]))?.get(POOL)).toEqual([OUTER]);
	});

	it('ignores DELEGATECALL and STATICCALL frames — they have no frame of their own', () => {
		const trace = call(OUTER, {
			calls: [
				{ type: 'DELEGATECALL', to: MID as `0x${string}`, calls: [
					{ type: 'STATICCALL', to: INNER as `0x${string}`, calls: [
						call(POOL, { logs: [log(POOL)] }),
					] },
				] },
			],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('skips reverted frames', () => {
		const trace = call(OUTER, {
			calls: [call(MID, { error: 'execution reverted', calls: [call(POOL, { logs: [log(POOL)] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('collapses consecutive repeats (the V4 unlock-callback re-entry)', () => {
		// Real shape: Executor -> PoolManager.unlock -> Executor.unlockCallback
		// -> PoolManager.swap. PoolManager is the venue (excluded), so Executor
		// would otherwise appear twice in a row.
		const trace = call(OUTER, {
			calls: [call(INNER, { calls: [call(POOL, { calls: [call(INNER, {
				calls: [call(POOL, { logs: [log(POOL)] })],
			})] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER, INNER]);
	});

	it('caps a chain at 12 frames, keeping the innermost', () => {
		// 20 nested frames 0x01..0x14, then the pool.
		const addrs = Array.from({ length: 20 }, (_, i) =>
			`0x${String(i + 1).padStart(2, '0').repeat(20)}`,
		);
		let node: TraceNode = call(POOL, { logs: [log(POOL)] });
		for (const a of [...addrs].reverse()) node = call(a, { calls: [node] });
		const chain = extractFrameChains(node, new Set([POOL])).get(POOL)!;
		expect(chain).toHaveLength(12);
		expect(chain[11]).toBe(addrs[19]);
		expect(chain[0]).toBe(addrs[8]);
	});

	it('omits a venue reached from two different chains (fail closed)', () => {
		// Two pools sharing one address (the V4 PoolManager singleton), called by
		// two different routers. Ambiguous -> no attribution for either.
		const trace = call(OUTER, {
			calls: [
				call(MID, { calls: [call(POOL, { logs: [log(POOL)] })] }),
				call(INNER, { calls: [call(POOL, { logs: [log(POOL)] })] }),
			],
		});
		expect(extractFrameChains(trace, new Set([POOL])).has(POOL)).toBe(false);
	});

	it('ignores logs from addresses that are not venues', () => {
		const trace = call(OUTER, { calls: [call(MID, { logs: [log(MID)] })] });
		expect(extractFrameChains(trace, new Set([POOL])).size).toBe(0);
	});

	it('matches any log from a venue, not just swap topics (RFQ + transfer-discovered venues)', () => {
		const trace = call(OUTER, { calls: [call(POOL, { logs: [log(POOL)] })] });
		expect(extractFrameChains(trace, new Set([POOL])).has(POOL)).toBe(true);
	});

	it('returns an empty map for a venue with no logs at all', () => {
		const trace = call(OUTER, { calls: [call(POOL)] });
		expect(extractFrameChains(trace, new Set([POOL])).size).toBe(0);
	});

	it('lowercases venue keys and frame addresses', () => {
		const trace = call(OUTER.toUpperCase().replace('0X', '0x'), {
			calls: [call(POOL, { logs: [log(POOL.toUpperCase().replace('0X', '0x'))] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- legFrameChains`
Expected: FAIL — `Failed to resolve import "./legFrameChains.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/legFrameChains.ts`:

```ts
/**
 * legFrameChains — which call frames did each venue get called from?
 *
 * A meta-aggregator can hand individual legs to another aggregator: on tx
 * 0x42fab3cd… the taker calls Relay, and both pool swaps execute inside
 * Fabric's Executor frame. The callTracer trace analyzeTransaction already
 * fetches carries that nesting; this module extracts it.
 *
 * DELIBERATELY REGISTRY-FREE. It emits raw addresses and never names anyone —
 * naming happens on read (resolveLegRouter.ts) so that adding a router to
 * configs/routers.json retroactively attributes every historical receipt that
 * ever touched it, with no repopulation. Putting a lookup here would trade
 * that away for nothing.
 *
 * A venue occurrence is ANY log whose emitter is a venue address — no
 * swap-topic filter. Maker (rfq) legs are identified by a fill topic and
 * transfer-discovered venues by no topic at all, so filtering on swap topics
 * would silently deny both any attribution.
 *
 * Nesting proves CONTAINMENT, not authorship: it shows whose contract the pool
 * call ran inside, not who chose the pool. Callers must not present it as
 * routing authorship.
 */
import type { TraceNode } from './tradeEndpoints.js';

/**
 * Max frames kept per chain — a bloat guard on route_legs, not a semantic
 * limit (deepest observed across the corpus is 3). Truncation keeps the
 * INNERMOST frames, since the innermost known router is the one displayed.
 */
const MAX_CHAIN = 12;

export function extractFrameChains(
	trace: TraceNode,
	venues: ReadonlySet<string>,
): Map<string, string[]> {
	// venue → the distinct chains it was reached by, JSON-encoded for set semantics.
	const observed = new Map<string, Set<string>>();

	const visit = (node: TraceNode, stack: readonly string[]): void => {
		const to = node.to?.toLowerCase();
		// Only CALL creates a frame: DELEGATECALL/STATICCALL execute in the
		// caller's context. Reverted frames did not happen. The venue itself is
		// never part of its own chain.
		const opensFrame =
			node.type === 'CALL' && to != null && to !== '' && !node.error && !venues.has(to);
		// Collapse CONSECUTIVE repeats: V4 runs
		// Executor → PoolManager.unlock → Executor.unlockCallback → PoolManager.swap,
		// and with PoolManager excluded the Executor would otherwise appear twice.
		const next =
			opensFrame && stack[stack.length - 1] !== to
				? [...stack, to].slice(-MAX_CHAIN)
				: stack;

		for (const entry of node.logs ?? []) {
			const emitter = entry.address.toLowerCase();
			if (!venues.has(emitter)) continue;
			let chains = observed.get(emitter);
			if (!chains) {
				chains = new Set();
				observed.set(emitter, chains);
			}
			chains.add(JSON.stringify(next));
		}

		for (const child of node.calls ?? []) visit(child, next);
	};
	visit(trace, []);

	const out = new Map<string, string[]>();
	for (const [venue, chains] of observed) {
		// Fail closed. One venue address reached by two different paths is
		// genuinely ambiguous — the V4 PoolManager singleton can host two pools
		// in one route, and legs join to frames by address, not log index.
		// Emitting nothing is honest; guessing is not.
		if (chains.size !== 1) continue;
		const chain = JSON.parse([...chains][0]!) as string[];
		if (chain.length > 0) out.set(venue, chain);
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- legFrameChains`
Expected: PASS, 11 tests.

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts`, add beside the other exports:

```ts
export { extractFrameChains } from './legFrameChains.js';
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --build && npm test`
Expected: typecheck clean; suite green with 11 new tests.
**Do not run `npm run build`** — the root build runs `next build` into the same `.next` a running dev server owns and breaks its CSS. `npx tsc --build` is the compile gate.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/legFrameChains.ts packages/core/src/legFrameChains.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): extract per-venue call-frame chains from the trace

Pure walk over the callTracer trace already fetched by analyzeTransaction:
for each venue address, the chain of enclosing CALL frames. Deliberately
registry-free -- raw addresses only, so naming can happen on read and stay
retroactive as routers.json grows.

Fails closed when one venue is reached by two different chains (the V4
PoolManager singleton hosting two pools), since legs join to frames by
address rather than log index.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Core — persist `frameChain` on each leg

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts` (import; `routeLegsBase` at :349)
- Create: `packages/core/src/legFrameChains.e2e.test.ts`
- Modify: `packages/dashboard/lib/queries.ts` (`RouteLeg` interface, :45-59)

**Interfaces:**
- Consumes: `extractFrameChains` (Task 1).
- Produces: each entry of the persisted `route_legs` array may carry `frameChain?: string[]`. Task 3 and Task 4 read it.

- [ ] **Step 1: Write the failing e2e test**

This is an RPC end-to-end test over the four real receipts, matching the house pattern in `beneficiaryAnchoring.e2e.test.ts`. Create `packages/core/src/legFrameChains.e2e.test.ts`:

```ts
/**
 * Live-RPC check that frame chains come out of real transactions the way the
 * corpus survey said they do. SKIPS without TCA_RPC_URL — export it before
 * gating on this file:
 *   set -a && source .env && set +a && npm test
 */
import { describe, expect, it } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const CHAIN = 8453;
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';
const RELAY_PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';

describe.skipIf(!RPC)('frame chains on real transactions', () => {
	it('puts every leg of id328 (Relay > Fabric) inside Fabric', async () => {
		const r = await analyzeTransaction(
			'0x42fab3cdcd675ff50236d8f59555ae2dab4b088521ed1a173d23b735499869a5',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs.length).toBeGreaterThan(0);
		for (const leg of legs) {
			expect(leg.frameChain).toBeDefined();
			expect(leg.frameChain!.at(-1)).toBe(FABRIC);
			expect(leg.frameChain![0]).toBe(RELAY_PROXY);
		}
	}, 60_000);

	it('attributes id250 to Fabric even though its top-level router is uncurated', async () => {
		const r = await analyzeTransaction(
			'0x9c53d5ec5a1d34e3b9f3da9b181cbe47b67e6bc198c42a1f55eddf4f0e9dccaf',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs).toHaveLength(4);
		for (const leg of legs) expect(leg.frameChain!.at(-1)).toBe(FABRIC);
	}, 60_000);

	it('leaves a single-aggregator trade with a chain that ends at that aggregator', async () => {
		// id135, KyberSwap. A chain still exists; it simply resolves to the
		// top-line aggregator, which Task 3 turns into "render nothing".
		const r = await analyzeTransaction(
			'0x783f45fec72a79ff3d54cf9897274604a70dc039eef4e257cc8117c65654f5fd',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs.length).toBeGreaterThan(0);
		expect(legs.every((l) => Array.isArray(l.frameChain))).toBe(true);
	}, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a && source .env && set +a && npm test -- legFrameChains.e2e`
Expected: FAIL — `expected undefined to be defined` on `leg.frameChain`.
If instead every test *skips*, `TCA_RPC_URL` is not exported: dotenv does not reach the repo-root `.env` from `packages/core`, and a plain `source .env` does not export. Use the `set -a` form above.

- [ ] **Step 3: Wire the extraction into `analyzeTransaction`**

Add the import beside the other core imports near `analyzeTransaction.ts:25`:

```ts
import { extractFrameChains } from './legFrameChains.js';
```

Replace the `routeLegsBase` block at `analyzeTransaction.ts:349-358` with:

```ts
		// Which call frame executed each leg? `trace` is the one already fetched
		// above — no extra RPC. Raw addresses only; naming happens on read so
		// registry growth is retroactive (see legFrameChains.ts).
		const venueAddresses = new Set(route.legs.map((l) => l.leg.venue.toLowerCase()));
		const frameChains = extractFrameChains(trace, venueAddresses);

		const routeLegsBase = route.legs.map((l) => {
			const frameChain = frameChains.get(l.leg.venue.toLowerCase());
			return {
				venue: l.leg.venue,
				type: l.leg.type,
				tokenIn: l.leg.tokenIn,
				tokenOut: l.leg.tokenOut,
				feeTierBps: l.feeTierBps,
				notionalUsdc: l.notionalUsdc,
				lpFeeBps: l.lpFeeBps,
				priceImpactBps: midReliable ? l.priceImpactBps : null,
				// Omitted (not null) when absent, matching attachLegSymbols' contract:
				// an absent key reads as "no attribution" on old and new rows alike.
				...(frameChain ? { frameChain } : {}),
			};
		});
```

`attachLegSymbols` spreads `...l`, so `frameChain` survives the symbol pass unchanged.

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `set -a && source .env && set +a && npm test -- legFrameChains.e2e`
Expected: PASS, 3 tests. Each hits live RPC; allow up to a minute.

- [ ] **Step 5: Declare the field on the dashboard's leg type**

In `packages/dashboard/lib/queries.ts`, inside `interface RouteLeg` (:45-59), after `tokenOutSymbol?: string;`:

```ts
	// Enclosing CALL frame addresses (outermost→innermost) for this leg's venue,
	// captured by core from the trace. Raw addresses — names are resolved on read
	// by resolveLegRouter so registry growth applies retroactively. Absent on
	// rows persisted before 2026-07-27 and on legs whose chain was ambiguous.
	frameChain?: string[];
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --build && set -a && source .env && set +a && npm test`
Expected: typecheck clean; full suite green including the 3 e2e tests. Confirm the e2e tests **ran** rather than skipped — a skipped RPC test is not a passing gate.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/legFrameChains.e2e.test.ts packages/dashboard/lib/queries.ts
git commit -m "$(cat <<'EOF'
feat(core): persist per-leg frameChain in route_legs

Attaches each leg's enclosing call-frame chain at the routeLegsBase step,
reusing the trace analyzeTransaction already fetched. route_legs is jsonb,
so no migration.

Live-RPC e2e over id328/id250 confirms both Relay>Fabric receipts and the
uncurated-top-level case land on Fabric.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Core — resolve a chain to a router (on read)

**Files:**
- Create: `packages/core/src/resolveLegRouter.ts`
- Create: `packages/core/src/resolveLegRouter.test.ts`
- Modify: `packages/core/src/index.ts` (add export)

**Interfaces:**
- Consumes: `resolveAggregator(to, logs)` from `./resolveAggregator.js`, which already covers **both** registries (`settlers.json` tier 1, `routers.json` tier 2) and returns `detectedVia: 'resolver' | 'address' | 'unknown'`. Calling it with `[]` logs is correct here: the `logs` argument only feeds triage hints on the unknown tier, which this module discards.
- Produces: `resolveLegRouter(frameChain: readonly string[] | undefined, topLevelSlug: string): ResolvedLegRouter | null` and `interface ResolvedLegRouter { slug: string; address: string; path: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/resolveLegRouter.test.ts`. Addresses below are real entries in `configs/routers.json` — the test exercises the live registry deliberately, so a curation regression breaks it.

```ts
import { describe, expect, it } from 'vitest';
import { resolveLegRouter } from './resolveLegRouter.js';

const RELAY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be'; // routers.json: Relay
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da'; // routers.json: Fabric
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'; // routers.json: KyberSwap
const UNKNOWN_A = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f'; // RelayRouterV3, uncurated
const UNKNOWN_B = '0x1b2b6ce813b99b840fe632c63bca5394938ef01e'; // VelodromeSlipstreamRouter

describe('resolveLegRouter', () => {
	it('returns the innermost known router when it differs from the top line', () => {
		expect(resolveLegRouter([RELAY, UNKNOWN_A, FABRIC], 'relay')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['relay', 'fabric'],
		});
	});

	it('drops uncurated frames from the path entirely', () => {
		const r = resolveLegRouter([RELAY, UNKNOWN_A, UNKNOWN_B, FABRIC], 'relay');
		expect(r!.path).toEqual(['relay', 'fabric']);
	});

	it('returns null when the innermost known router IS the top-line aggregator', () => {
		expect(resolveLegRouter([KYBER, UNKNOWN_A], 'kyberswap')).toBeNull();
	});

	it('returns null on re-entry — the top-line aggregator took the leg back', () => {
		// Relay > Fabric > Relay. A real participant (Fabric) goes unmentioned;
		// that is a decided tradeoff, not an oversight (see the design doc).
		expect(resolveLegRouter([RELAY, FABRIC, RELAY], 'relay')).toBeNull();
	});

	it('attributes even when the top-line aggregator is uncurated', () => {
		// id250: top line is the bare address 0x5f693aa7…, so the path is Fabric
		// alone — length 1, which Task 5 renders without a tooltip.
		expect(resolveLegRouter([UNKNOWN_A, FABRIC], '0x5f693aa785c5c8301f21ec9d204cde209514d431')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['fabric'],
		});
	});

	it('returns null when no frame is a known router', () => {
		expect(resolveLegRouter([UNKNOWN_A, UNKNOWN_B], 'relay')).toBeNull();
	});

	it('returns null for an absent or empty chain', () => {
		expect(resolveLegRouter(undefined, 'relay')).toBeNull();
		expect(resolveLegRouter([], 'relay')).toBeNull();
	});

	it('collapses consecutive frames belonging to the same aggregator', () => {
		// Nordstern runs two routers; two of its own frames in a row are one hop.
		const N1 = '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d';
		const N2 = '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251';
		expect(resolveLegRouter([RELAY, N2, N1], 'relay')!.path).toEqual(['relay', 'nordstern']);
	});

	it('is case-insensitive on both the chain and the top-level slug', () => {
		expect(resolveLegRouter([RELAY.toUpperCase().replace('0X', '0x'), FABRIC], 'RELAY')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['relay', 'fabric'],
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- resolveLegRouter`
Expected: FAIL — `Failed to resolve import "./resolveLegRouter.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/resolveLegRouter.ts`:

```ts
/**
 * resolveLegRouter — which aggregator executed this leg?
 *
 * Read-time counterpart to legFrameChains.ts. Given a leg's raw frame chain
 * and the receipt's top-line aggregator, returns the innermost CURATED router
 * that is not the top line — or null.
 *
 * Resolution lives here, not in analysis, so that adding an address to
 * configs/routers.json retroactively attributes every historical receipt that
 * ever touched it. Note the registries are read once at module load (see
 * tagging.ts and resolveAggregator.ts), so a config edit needs a process
 * RESTART, not merely a page refresh.
 *
 * Only curated registries attribute. A corpus survey found that the unnamed
 * frames between aggregators and pools are overwhelmingly DEX periphery
 * routers (VelodromeSlipstreamRouter, SwapRouter) and aggregators' own
 * executors — not sub-aggregators. Naming those would be worse than silence.
 *
 * The result means EXECUTED BY, never route authorship: frame nesting proves
 * containment only. Do not aggregate it into "routed volume" claims.
 */
import { resolveAggregator } from './resolveAggregator.js';

export interface ResolvedLegRouter {
	/** Aggregator slug of the innermost known router (feeds formatProvider). */
	slug: string;
	/** That frame's contract address, lowercased — the Basescan link target. */
	address: string;
	/** Known routers in the chain, outermost→innermost, including the top line
	 *  when it is itself curated. Rendered as a tooltip only when longer than 2. */
	path: string[];
}

export function resolveLegRouter(
	frameChain: readonly string[] | undefined,
	topLevelSlug: string,
): ResolvedLegRouter | null {
	if (!frameChain || frameChain.length === 0) return null;

	const known: { slug: string; address: string }[] = [];
	for (const frame of frameChain) {
		// Empty logs: the argument only produces triage hints on the unknown
		// tier, which we discard anyway.
		const resolution = resolveAggregator(frame, []);
		if (resolution.detectedVia === 'unknown') continue;
		// One aggregator's own routers in sequence (Nordstern runs two) is one hop.
		if (known[known.length - 1]?.slug === resolution.slug) continue;
		known.push({ slug: resolution.slug, address: frame.toLowerCase() });
	}
	if (known.length === 0) return null;

	const innermost = known[known.length - 1]!;
	// Null when the innermost IS the top line. Covers the ordinary
	// single-aggregator trade (where a tag would be pure noise) and the
	// re-entry case Relay > Fabric > Relay, where Relay took the leg back —
	// there a real participant goes unmentioned, by decision.
	if (innermost.slug === topLevelSlug.toLowerCase()) return null;

	return {
		slug: innermost.slug,
		address: innermost.address,
		path: known.map((k) => k.slug),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- resolveLegRouter`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts`:

```ts
export { resolveLegRouter, type ResolvedLegRouter } from './resolveLegRouter.js';
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --build && npm test`
Expected: clean; suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/resolveLegRouter.ts packages/core/src/resolveLegRouter.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): resolve a leg's frame chain to its executing router

Innermost curated router that differs from the receipt's top-line
aggregator, or null. Reuses resolveAggregator so both settlers.json and
routers.json attribute, and consecutive frames of one aggregator collapse
to a single hop.

Resolution is read-time by design: growing routers.json retroactively
attributes historical receipts with no repopulation (restart required --
the registries are read once at module load).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Dashboard — enrich legs server-side on read

**Files:**
- Modify: `packages/dashboard/lib/queries.ts` (`RouteLeg` interface; `listReceipts` :13-16; `getReceiptByHash` :19-27)
- Create: `packages/dashboard/lib/legRouterEnrichment.test.ts`

**Interfaces:**
- Consumes: `resolveLegRouter`, `ResolvedLegRouter` (Task 3); `RouteLeg.frameChain` (Task 2).
- Produces: `enrichLegRouters(row: ReceiptRow): ReceiptRow` (exported for test) and `RouteLeg.router?: ResolvedLegRouter`. Every row returned by `listReceipts` / `getReceiptByHash` has this applied. Task 5 reads `leg.router`.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/lib/legRouterEnrichment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { enrichLegRouters } from './queries';
import type { ReceiptRow } from './queries';

const RELAY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';

const row = (aggregator: string, routeLegs: unknown): ReceiptRow =>
	({ aggregator, routeLegs }) as unknown as ReceiptRow;

describe('enrichLegRouters', () => {
	it('attaches the resolved router to a leg executed by another aggregator', () => {
		const out = enrichLegRouters(
			row('Relay', [{ venue: '0xpool', frameChain: [RELAY, FABRIC] }]),
		);
		const legs = out.routeLegs as { router?: { slug: string; path: string[] } }[];
		expect(legs[0]!.router).toEqual({ slug: 'fabric', address: FABRIC, path: ['relay', 'fabric'] });
	});

	it('leaves a leg untouched when the router resolves to the top line', () => {
		const out = enrichLegRouters(row('Relay', [{ venue: '0xpool', frameChain: [RELAY] }]));
		const legs = out.routeLegs as { router?: unknown }[];
		expect(legs[0]!.router).toBeUndefined();
	});

	it('leaves legs from rows persisted before frameChain existed untouched', () => {
		const out = enrichLegRouters(row('Relay', [{ venue: '0xpool' }]));
		const legs = out.routeLegs as { router?: unknown }[];
		expect(legs[0]!.router).toBeUndefined();
	});

	it('passes through a row whose routeLegs is not an array', () => {
		expect(enrichLegRouters(row('Relay', null)).routeLegs).toBeNull();
	});

	it('enriches per leg, not per receipt', () => {
		const out = enrichLegRouters(
			row('Relay', [
				{ venue: '0xa', frameChain: [RELAY, FABRIC] },
				{ venue: '0xb', frameChain: [RELAY] },
			]),
		);
		const legs = out.routeLegs as { router?: { slug: string } }[];
		expect(legs[0]!.router?.slug).toBe('fabric');
		expect(legs[1]!.router).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- legRouterEnrichment`
Expected: FAIL — `enrichLegRouters` is not exported from `./queries`.

- [ ] **Step 3: Implement the enrichment**

In `packages/dashboard/lib/queries.ts`, add to the imports at the top:

```ts
import { resolveLegRouter, type ResolvedLegRouter } from '@fabric-tca/core';
```

This module is server-only (it calls `getDb`), and every component that imports from it uses `import type`, which is erased — so pulling in the fs-touching core barrel here does not reach the client bundle. Keep it that way.

Add `router` to the `RouteLeg` interface, directly after the `frameChain` field added in Task 2:

```ts
	// Resolved from `frameChain` on read (never persisted) — see
	// enrichLegRouters. Present only when another curated aggregator executed
	// this leg.
	router?: ResolvedLegRouter;
```

Add the helper below the `RouteLeg` interface:

```ts
/**
 * Resolve each leg's persisted `frameChain` into a named router, on read.
 *
 * Deliberately not persisted: doing it here means adding an address to
 * configs/routers.json retroactively attributes every historical receipt,
 * with no repopulation. Runs server-side only — resolveLegRouter reads the
 * registries from disk and must never cross into a client bundle.
 *
 * Exported for tests; every query below applies it.
 */
export function enrichLegRouters(row: ReceiptRow): ReceiptRow {
	if (!Array.isArray(row.routeLegs)) return row;
	const topLevelSlug = String(row.aggregator ?? '').toLowerCase();
	const legs = (row.routeLegs as RouteLeg[]).map((leg) => {
		const router = resolveLegRouter(leg.frameChain, topLevelSlug);
		return router ? { ...leg, router } : leg;
	});
	return { ...row, routeLegs: legs };
}
```

Apply it in both readers:

```ts
/** All receipts, most recently created first. */
export async function listReceipts(): Promise<ReceiptRow[]> {
	const db = getDb();
	const rows = await db.select().from(schema.receipts).orderBy(desc(schema.receipts.createdAt));
	return rows.map(enrichLegRouters);
}
```

and in `getReceiptByHash`, change the final line from `return rows[0] ?? null;` to:

```ts
	return rows[0] ? enrichLegRouters(rows[0]) : null;
}
```

Leave `insertReceipt` alone — it returns the freshly-inserted row to the API route, which does not render legs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- legRouterEnrichment`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --build && npm test`
Expected: clean; suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/lib/queries.ts packages/dashboard/lib/legRouterEnrichment.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): resolve per-leg routers in the query layer

listReceipts and getReceiptByHash now attach leg.router, resolved from the
persisted frameChain. Server-side only: every component imports from
lib/queries with `import type`, so the fs-touching core barrel stays out of
the client bundle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Dashboard — render the router tag

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx` (`BkdRow` :220-292, `LegRow` :298-331)
- Modify: `packages/dashboard/components/receiptView.test.tsx` (add a describe block)

**Interfaces:**
- Consumes: `RouteLeg.router` (Task 4); `TooltipBubble` (module-private, `receiptRows.tsx:26`); `formatProvider` from `../../lib/formatters` (already imported at `receiptRows.tsx:8`).
- Produces: no new exports. `BkdRow`'s `context` prop widens from `string | undefined` to `React.ReactNode`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/components/receiptView.test.tsx`:

```ts
describe('LegRow router attribution', () => {
	const baseRow = {
		inputToken: '0x4200000000000000000000000000000000000006',
		outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		inputSymbol: 'WETH',
		outputSymbol: 'USDC',
	};
	const leg = (router?: { slug: string; address: string; path: string[] }) => ({
		venue: '0x345825a980bd94e1480bc4f20fe4e3dae2f23dd3',
		type: 'pancakev3',
		tokenIn: baseRow.inputToken,
		tokenOut: baseRow.outputToken,
		tokenInSymbol: 'WETH',
		tokenOutSymbol: 'USDC',
		feeTierBps: 5,
		notionalUsdc: 1000,
		lpFeeBps: 5,
		priceImpactBps: 1,
		...(router ? { router } : {}),
	});

	const render = async (l: ReturnType<typeof leg>) => {
		const { LegRow } = await import('./receipt/receiptRows');
		return renderToStaticMarkup(
			React.createElement(LegRow, {
				leg: l as never,
				index: 0,
				legsLength: 1,
				row: baseRow as never,
				value: '5.0bps',
			}),
		);
	};

	it('renders the pair alone when no other aggregator executed the leg', async () => {
		const html = await render(leg());
		expect(html).toContain('WETH/USDC');
		expect(html).not.toContain('basescan.org/address/0x7c137a37');
	});

	it('appends the router, linked to its Basescan contract page', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
		);
		expect(html).toContain('WETH/USDC');
		expect(html).toContain('Fabric');
		expect(html).toContain('href="https://basescan.org/address/0x7c137a37742437d2212b7bd873ed135b5c4c61da"');
	});

	it('shows no tooltip at depth 2', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
		);
		expect(html).not.toContain('role="tooltip"');
	});

	it('shows the full arrow-joined path in a tooltip above depth 2', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'odos', 'fabric'] }),
		);
		expect(html).toContain('role="tooltip"');
		expect(html).toContain('Relay → Odos → Fabric');
	});

	it('renders no router tag on a wrap step row', async () => {
		const wrapLeg = {
			...leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
			type: 'wrap',
		};
		const html = await render(wrapLeg as never);
		expect(html).toContain('ETH → WETH');
		expect(html).not.toContain('basescan.org/address/0x7c137a37');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- receiptView`
Expected: the four new router assertions FAIL (no `Fabric`, no Basescan href, no tooltip); the first and last may already pass.

- [ ] **Step 3: Widen `BkdRow`'s context prop**

In `packages/dashboard/components/receipt/receiptRows.tsx`, in `BkdRow`'s props type (:233), change:

```ts
	context?: string | undefined;
```

to:

```ts
	/** Trailing muted detail beside the label — the token pair, plus the
	 *  executing router when another aggregator ran this leg. A node, not a
	 *  string, because the router segment is a link and above depth 2 also a
	 *  tooltip trigger. */
	context?: React.ReactNode;
```

The render site at :276-278 needs no change — `{context}` already accepts a node; only the `!= null` guard matters and it still holds.

- [ ] **Step 4: Add the router tag component**

In the same file, add above `LegRow`:

```tsx
/**
 * The executing-router tag in a leg's context slot: `WETH/cbBTC • Fabric`.
 *
 * Quaternary rather than the provider accent — per-leg accents made the
 * breakdown noisy. The link target is the frame's own contract address, so it
 * resolves to whichever router of that aggregator actually ran (several
 * aggregators run more than one).
 *
 * The full path appears only above depth 2. At depth 2 it is just
 * `topLine › thisRouter`, and the top line is already stated at the head of
 * the receipt, so a tooltip would restate what the reader can see.
 */
function LegRouterTag({ router }: { router: NonNullable<RouteLeg['router']> }) {
	const link = (
		<a
			href={`https://basescan.org/address/${router.address}`}
			target="_blank"
			rel="noreferrer"
			className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
		>
			{formatProvider(router.slug, { full: true })}
		</a>
	);
	if (router.path.length <= 2) return link;
	return (
		<span className="group relative">
			{link}
			<TooltipBubble align="left">
				{router.path.map((slug) => formatProvider(slug, { full: true })).join(' → ')}
			</TooltipBubble>
		</span>
	);
}
```

- [ ] **Step 5: Compose the context in `LegRow`**

Replace `LegRow`'s body (:315-330) with:

```tsx
	const stepContext = getStepContext(leg.type);
	const isStep = stepContext != null;
	const hasPair = leg.tokenIn && leg.tokenOut;
	const hideContext = requirePair && !isStep && !hasPair;
	const maker = isMakerLeg(leg);
	const pair = stepContext ?? (hideContext ? undefined : legPairContext(leg, index, legsLength, row));
	// Step rows (wrap/unwrap) never carry a router tag: their context slot holds
	// the step itself, and wrapping is not a routing decision.
	const context =
		leg.router && !isStep ? (
			<>
				{pair}
				{pair ? ' • ' : ''}
				<LegRouterTag router={leg.router} />
			</>
		) : (
			pair
		);
	return (
		<BkdRow
			label={getVenueLabel(leg)}
			href={`https://basescan.org/address/${leg.venue}`}
			context={context}
			value={value}
			color={color}
			secondary
			{...(maker ? { labelColor: 'var(--color-secondary)', valueTooltip: RFQ_LEG_TOOLTIP } : {})}
		/>
	);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- receiptView`
Expected: PASS including all five new tests.

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `npx tsc --build && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): show the executing router on each route leg

Renders `WETH/cbBTC • Fabric` in the leg's context slot, quaternary, linked
to the router frame's Basescan page. The full arrow-joined path appears in a
tooltip only above depth 2 -- at depth 2 the outer hop is the top-line
aggregator, already stated at the head of the receipt.

BkdRow's `context` widens to ReactNode so the router segment can be a link.
Step rows (wrap/unwrap) are excluded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Backfill and verify against the live corpus

**Files:**
- Modify: `scripts/repopulateReceipts.mjs` (WATCH list, :61) — reporting only
- No source changes

**Interfaces:**
- Consumes: everything above.
- Produces: 48 persisted rows carrying `frameChain`; nothing downstream depends on this task.

`route_legs` is already in the script's UPDATE set (`scripts/repopulateReceipts.mjs:47`), so chains persist without any change to the write path. The WATCH edit only surfaces the change in the dry-run diff.

- [ ] **Step 1: Rebuild core dist — the script imports from `dist`, not `src`**

Run: `npx tsc --build`

Skipping this makes the repopulation silently write the OLD leg shape: `repopulateReceipts.mjs:14` imports `packages/core/dist/analyzeTransaction.js`. This exact trap ate a session during the fee-sinks work.

- [ ] **Step 2: Add `routeLegs` to the drift-report WATCH list**

In `scripts/repopulateReceipts.mjs:61`, change:

```js
const WATCH = ['tier', 'pricingStatus', 'routeShape', 'hopCount', 'allInCostBps', 'executionBps', 'lpFeeBps', 'aggFeeBps', 'slippageBps', 'decompConfidence'];
```

to:

```js
const WATCH = ['tier', 'pricingStatus', 'routeShape', 'hopCount', 'allInCostBps', 'executionBps', 'lpFeeBps', 'aggFeeBps', 'slippageBps', 'decompConfidence', 'routeLegs'];
```

- [ ] **Step 3: Dry-run the repopulation**

Run (background — 48 rows exceeds the 5-minute foreground tool timeout):

```bash
set -a && source .env && set +a && node scripts/repopulateReceipts.mjs 2>&1 | tee /tmp/repop-dry.log
```

Expected: every row reports a `routeLegs:` diff (the new `frameChain` key) and **no** diff on `tier`, `lpFeeBps`, `aggFeeBps`, `slippageBps`, or `executionBps`. A pricing-column diff means something outside this feature changed and must be understood before committing the write.

- [ ] **Step 4: Commit the repopulation**

Run (background, same reason):

```bash
set -a && source .env && set +a && node scripts/repopulateReceipts.mjs --commit 2>&1 | tee /tmp/repop-commit.log
```

The flag is plain argv (`repopulateReceipts.mjs:28`: `const COMMIT = process.argv.includes('--commit')`). Confirm the closing line reads `WROTE: 48 rows · changed=48 · null-now(skipped)=0 · errors=0`. A non-zero `errors` or a `null-now` skip means a receipt failed to re-analyze — investigate before proceeding, since a skipped row keeps its old legs and will silently render without a tag.

- [ ] **Step 5: Verify the four known receipts in the browser**

Start the dev server if it is not already running (`npm run dev`, port 3000) and open each:

| tx | expect |
|---|---|
| `0x42fab3cd…99869a5` (id 328) | both legs tagged `Fabric`, linked to `0x7c137a37…`, no tooltip |
| `0xc46c08eb…4dbebd3` (id 216) | both legs tagged `Fabric`, no tooltip |
| `0x9c53d5ec…0e9dccaf` (id 250) | all four legs tagged `Fabric`, no tooltip (path length 1) |
| `0x783f45fe…5654f5fd` (id 307) | legs tagged `0x` |

Also open any KyberSwap or Nordstern receipt and confirm **no** tag appears — those have unnamed inner frames (`0x8f10b468…`, `0xe7dc2934…`) that must stay unattributed.

Confirm on the widest case that the label group wraps to a second line rather than overflowing or clipping, and that the wrapped line reads correctly.

- [ ] **Step 6: Full suite**

Run: `set -a && source .env && set +a && npm test`
Expected: green, with the RPC e2e tests **running** rather than skipping.

- [ ] **Step 7: Commit**

```bash
git add scripts/repopulateReceipts.mjs
git commit -m "$(cat <<'EOF'
chore(data): backfill per-leg frameChain across all receipts

Adds routeLegs to the repopulation drift-report WATCH list and backfills
48 rows. Verified id328/id216/id250 tag Fabric and id307 tags 0x, with no
tag on the KyberSwap/Nordstern receipts whose inner frames are uncurated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Core pure extraction, all filtering rules, emitter-address matching | 1 |
| §1 Wiring at `analyzeTransaction.ts:349`, address-keyed join, fail-closed guard | 1 (guard), 2 (wiring) |
| §2 DB — `frameChain` in `route_legs`, no migration | 2 |
| §3 `resolveLegRouter`, innermost / differs-from-top / re-entry / null cases | 3 |
| §3 Called from `lib/queries.ts`, returns slug not name | 4 |
| §4 `BkdRow.context` widening, `LegRow` composition, link, quaternary, tooltip above depth 2, step-row exclusion | 5 |
| §4 Width — verify wrapping, no code change | 6 (step 5) |
| §Repopulation | 6 |
| §Testing — all listed cases | 1, 3, 4, 5 |

**Known gaps, deliberate:**

- **RFQ/maker legs get no dedicated test.** They flow through the identical code path (matching is by emitter address, with no topic filter, precisely so maker legs are covered), and no receipt in the corpus has a maker leg inside a second aggregator — so a test would assert on fabricated data. The generic "any log from a venue" test in Task 1 covers the mechanism.
- **The `hopCount`/`linearFlowValid` follow-ups** in the refactor backlog are untouched; out of scope.

**Type consistency:** `frameChain: string[]` is written in Task 2, declared in Task 2 (`queries.ts`), consumed in Tasks 3–4. `ResolvedLegRouter { slug, address, path }` is defined in Task 3 and used unchanged in Tasks 4–5. `extractFrameChains(trace, venues)` and `resolveLegRouter(frameChain, topLevelSlug)` keep the same argument order everywhere. `enrichLegRouters` is named identically in Task 4's implementation, test, and both call sites.
