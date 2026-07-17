# Market-Maker (RFQ) Leg Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Legs filled by market makers get typed `rfq`, deliberately unpriced (no fake AMM benchmark), labeled "Market Maker" with a tooltip, and stop carrying phantom defaulted-fee confidence penalties.

**Architecture:** A retype pass in `decomposeRoute` right after the route graph is built (tier 1: maker-fill event registry, no RPC; tier 2: block-pinned EOA / EIP-1967-proxy probe, injectable). Pricing then skips `rfq` legs before the midReader (deliberate null ≠ failure), and the dashboard splits the `rfq`/`unknown` label alias.

**Tech Stack:** TypeScript (ESM), vitest, viem (probe + e2e), postgres (rollout only).

**Spec:** `docs/superpowers/specs/2026-07-16-rfq-maker-legs-design.md` — read it first.

## Global Constraints

- NEVER run root `npm run build` (it runs `next build` into the live dev server's `.next`). Compile core with `npx tsc --build` only.
- Env vars: `source .env` does NOT export — use `set -a && source .env && set +a`.
- vitest CLI args are substring filters — always pass full file paths; run from the repo root.
- DB rows are repopulated **in place** (UPDATE preserving id) — never delete+re-POST.
- ⚠️ "Emitted no logs" is NOT a maker signal — measured BACKWARDS on `0xb020…9e26` (maker emitted 8 logs, the real pool emitted 0). Detection is fill-event registry + EOA/EIP-1967 structure only.
- The flag prefix `RFQ_LEG_UNPRICED` and the label "Market Maker" are exact contract strings — later tasks and tests assert on them verbatim.
- `packages/core/src` uses TABS; `packages/dashboard` uses TABS; test files match their file's existing style.
- All commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: rfq retype pass in decomposeRoute (detection + flag)

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (constants near top; `DecomposeRouteDeps` at :120-131; new probe factory near `createDefaultV3FactoryReader` ~:504; retype pass in `decomposeRoute` right after the netted-legs flag loop that follows `buildRouteGraph` ~:755-761)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: `graph.legs` (`Leg[]` with `type: VenueType`), `logs` (from `collectTraceLogs`, in scope at the retype site), `routeFlags`.
- Produces: legs retyped `'rfq'`; flag string `RFQ_LEG_UNPRICED: leg <venue10> — off-chain quote, no on-chain mid exists` (Tasks 2-4 assert the `RFQ_LEG_UNPRICED` prefix); new dep `rfqProbe?: (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> | 'eoa' | 'proxy1967' | 'contract'`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('decomposeRoute', …)` block in `packages/core/src/decomposeRoute.test.ts`. Reuse the file's `transferLog` helper and `USDC`/`VIRTUAL`/`WETH` constants; copy `swapLog`/`UNI_V3_SWAP_TOPIC` locally (they're scoped to other describes):

```ts
  describe('rfq maker retype pass', () => {
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const maker = '0x69a9f1560000000000000000000000000000aaaa' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;
    const RFQ_FILL_TOPIC = '0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d' as `0x${string}`;
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }
    // trader USDC → maker → VIRTUAL → poolB → WETH (2-hop linear)
    function makeTrace(withFillEvent: boolean) {
      return {
        from: syntheticTrader,
        to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
        input: '0x' as `0x${string}`,
        logs: [
          ...(withFillEvent ? [{
            address: maker,
            data: '0x' + '00'.repeat(96) as `0x${string}`,
            topics: [RFQ_FILL_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`] as [`0x${string}`, `0x${string}`],
          }] : []),
          swapLog(poolB),
          transferLog(USDC as `0x${string}`, syntheticTrader, maker, 1_000000n),
          transferLog(VIRTUAL as `0x${string}`, maker, poolB, 3_000000000000000000n),
          transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
        ],
        calls: [],
      };
    }
    function makeInput(trace: unknown): DecomposeTradeInput {
      return {
        trace: trace as any,
        txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        trader: syntheticTrader,
        direction: 'buy_weth',
        settledIn: 'WETH',
        allInCostBps: -5.0,
        notionalUsdc: 1.0,
        realizedPrice: 1800,
        gasCostUsd: 0.001,
        aggregator: 'Unknown',
        blockNumber: 100n,
        rpcUrl: 'unused',
        dustUsdc: 1e-6,
        structuralFloorUsd: 0,
        structuralFloorBps: 0.5,
      };
    }
    const feeReader = async (_addr: string, type: string) =>
      type === 'univ3' ? { bps: 5, defaulted: false } : { bps: 0, defaulted: false };

    it('tier 1: retypes a leg whose venue emitted a known maker-fill topic (no probe call)', async () => {
      const trace = makeTrace(true);
      const probeCalls: string[] = [];
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: (addr) => { probeCalls.push(addr); return 'contract'; },
      });
      const makerLeg = result.legs.find((l) => l.leg.venue === maker)!;
      expect(makerLeg.leg.type).toBe('rfq');
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(true);
      expect(probeCalls).not.toContain(maker); // tier 1 short-circuits tier 2
    });

    it('tier 2: retypes an EOA / EIP-1967-proxy counterparty; plain contracts stay unknown', async () => {
      const trace = makeTrace(false);
      for (const [probeResult, expected] of [['eoa', 'rfq'], ['proxy1967', 'rfq'], ['contract', 'unknown']] as const) {
        const result = await decomposeRoute(makeInput(trace), {
          trace: trace as any,
          feeReader,
          rfqProbe: (addr) => (addr === maker ? probeResult : 'contract'),
        });
        const makerLeg = result.legs.find((l) => l.leg.venue === maker)!;
        expect(makerLeg.leg.type).toBe(expected);
      }
    });

    it('never retypes or probes a recognized venue', async () => {
      const trace = makeTrace(false);
      const probeCalls: string[] = [];
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: (addr) => { probeCalls.push(addr); return 'eoa'; },
      });
      const poolLeg = result.legs.find((l) => l.leg.venue === poolB)!;
      expect(poolLeg.leg.type).toBe('univ3');
      expect(probeCalls).not.toContain(poolB); // only `unknown` legs are candidates
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/decomposeRoute.test.ts`
Expected: the three new tests FAIL — first on TypeScript/`rfqProbe` being an unknown dep property or on `makerLeg.leg.type` being `'unknown'` instead of `'rfq'`. Pre-existing tests PASS. (Known ~15s/test slowness in this file; add a `20_000` timeout third arg to any new `it` that times out.)

- [ ] **Step 3: Implement**

In `packages/core/src/decomposeRoute.ts`:

3a. Constants (near the other module constants at the top):

```ts
/** topic0s emitted BY a market maker's own contract when it fills an RFQ order.
 *  Seed verified on-chain 2026-07-16: emitted 8x by 0x Settler maker proxy
 *  0x69a9f156… in 0xb020…9e26. Extend like venue event-topics — never by address. */
const RFQ_FILL_TOPICS: ReadonlySet<string> = new Set([
	'0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d',
]);
/** EIP-1967 implementation slot (keccak256('eip1967.proxy.implementation') - 1). */
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
```

3b. Add to `DecomposeRouteDeps` (after `decimalsReader`):

```ts
	/** Structural maker probe for the rfq retype pass (block-pinned in production). */
	rfqProbe?: (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> | 'eoa' | 'proxy1967' | 'contract';
```

3c. Probe factory (next to `createDefaultV3FactoryReader`):

```ts
function createDefaultRfqProbe(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> {
	if (rpcUrl === 'unused') {
		return async () => 'contract';
	}
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	return async (addr: string): Promise<'eoa' | 'proxy1967' | 'contract'> => {
		try {
			const code = await rpc.getBytecode({ address: addr as `0x${string}`, blockNumber });
			if (!code || code === '0x') return 'eoa';
			const slot = await rpc.getStorageAt({ address: addr as `0x${string}`, slot: EIP1967_IMPL_SLOT as `0x${string}`, blockNumber });
			if (slot != null && BigInt(slot) !== 0n) return 'proxy1967';
			return 'contract';
		} catch {
			return 'contract'; // fail closed: an unprobeable address stays `unknown`
		}
	};
}
```

3d. Retype pass in `decomposeRoute`, directly AFTER the `LEG_AMOUNTS_NETTED` flag loop (which follows `buildRouteGraph`):

```ts
	// Step 4b: retype market-maker fills. A 1-in-1-out counterparty typed
	// `unknown` is re-typed `rfq` when it is provably a maker: tier 1 — it
	// emitted a known maker-fill event in THIS tx (no RPC); tier 2 — it is an
	// EOA or an EIP-1967 proxy at the trade block. Real AMM pools (plain
	// contracts, impl slot 0) stay `unknown`. ⚠️ "emitted no logs" is NOT a
	// maker signal — measured backwards on 0xb020…9e26 (the maker emitted 8
	// logs; the real pool emitted 0). See spec 2026-07-16-rfq-maker-legs.
	const rfqProbe = deps?.rfqProbe ?? createDefaultRfqProbe(input.rpcUrl, input.blockNumber);
	const fillEmitters = new Set<string>();
	for (const log of logs) {
		const topic0 = log.topics?.[0]?.toLowerCase();
		if (topic0 && RFQ_FILL_TOPICS.has(topic0)) fillEmitters.add(log.address.toLowerCase());
	}
	for (const leg of graph.legs) {
		if (leg.type !== 'unknown') continue;
		const isMaker = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
		if (!isMaker) continue;
		leg.type = 'rfq';
		routeFlags.push(`RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`);
	}
```

(`logs` is already in scope from Step 3's `collectTraceLogs(trace)`. If `LogLike`'s field names differ, adapt the two reads — address + topics[0] — to that type.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/decomposeRoute.test.ts`
Expected: ALL pass. Note: the retype happens before fee resolution, so the retyped maker's fee becomes `{bps: 0, defaulted: false}` via the existing `'rfq'` case at decomposeRoute.ts:495-496 — nothing to change there.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx tsc --build && git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts && git commit -m "feat(core): retype market-maker fills as rfq (fill-event registry + EOA/1967 probe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: rfq pricing semantics (deliberate null, recon gate, tokenPricing guard)

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (Step-9 pricing loop ~:820-871; recon gate ~:874-881)
- Modify: `packages/core/src/tokenPricing.ts:494-501`
- Test: `packages/core/src/decomposeRoute.test.ts` (extend the Task-1 describe)

**Interfaces:**
- Consumes: `leg.type === 'rfq'` from Task 1.
- Produces: rfq legs' `priceImpactBps` null without setting `hasNullMid`; `reconResidualBps` null whenever an rfq leg is present; `getVenueMidAtBlock` (tokenPricing) returns null for `'rfq'`.

- [ ] **Step 1: Write the failing test**

Append inside the Task-1 `describe('rfq maker retype pass', …)` block (reuses its helpers):

```ts
    it('prices around an rfq leg: deliberate null, no confidence downgrade, recon null', async () => {
      const trace = makeTrace(true); // tier-1 maker
      const stubMids: Record<string, number> = {
        [`${VIRTUAL}:${WETH}`]: 0.000166667, // matches realized → tiny PI for poolB
      };
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: () => 'contract',
        midReader: async (leg) => {
          if (leg.type === 'rfq') throw new Error('midReader must never see an rfq leg');
          const price = stubMids[`${leg.tokenIn}:${leg.tokenOut}`];
          return price === undefined ? null : { price, poolAddress: 'stub', poolKind: 'stub' };
        },
      });
      const makerLeg = result.legs.find((l) => l.leg.type === 'rfq')!;
      expect(makerLeg.priceImpactBps).toBeNull();       // deliberate null
      const poolLeg = result.legs.find((l) => l.leg.type === 'univ3')!;
      expect(poolLeg.priceImpactBps).not.toBeNull();     // other legs still priced
      expect(result.reconResidualBps).toBeNull();        // recon incomplete by design
      // The rfq null is NOT a pricing failure: no MID_NULL flag, confidence 'high'
      // (fees resolved, no approx legs, no netting — only the rfq null could downgrade).
      expect(result.flags.some((f) => f.startsWith('MID_NULL'))).toBe(false);
      expect(result.confidence).toBe('high');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/decomposeRoute.test.ts`
Expected: FAIL — today the loop calls the midReader for the rfq leg (test's midReader throws), or (if the throw path differs) confidence lands 'low' via `hasNullMid && hasSomeMid`.

- [ ] **Step 3: Implement**

3a. `packages/core/src/decomposeRoute.ts`, Step-9 loop. Declare the tracker next to `hasNullMid` (~:821):

```ts
		let hasNullMid = !midReader; // no reader → treat as all-null (skip loop body)
		let hasRfqLeg = false;       // rfq legs are DELIBERATELY unpriced — tracked separately
```

Then at the top of the `for (const lwl of legsWithLp)` body, right after `const leg = lwl.leg;`:

```ts
			// RFQ fills are quoted off-chain: there is no pool mid to compare to.
			// Null is deliberate (flagged RFQ_LEG_UNPRICED at retype), NOT a
			// pricing failure — do not set hasNullMid, do not call the midReader.
			if (leg.type === 'rfq') {
				lwl.priceImpactBps = null;
				hasRfqLeg = true;
				continue;
			}
```

3b. Recon gate (~:877) — change:

```ts
		if (!hasNullMid && legsWithLp.some((l) => l.priceImpactBps !== null)) {
```

to:

```ts
		// An rfq leg's spread is real cost that per-leg PI cannot see; a residual
		// would just re-absorb it and trigger a spurious RECON_LOW downgrade.
		if (!hasNullMid && !hasRfqLeg && legsWithLp.some((l) => l.priceImpactBps !== null)) {
```

(The `hasNullMid && hasSomeMid → low` downgrade needs NO change: rfq skips never set `hasNullMid`.)

3c. `packages/core/src/tokenPricing.ts:494-501` — replace:

```ts
  // RFQ / unknown, plus venues whose own mid we cannot read directly
  // (non-v3 math or no price getter) -- use factory discovery
  if (
    type === 'rfq' || type === 'unknown' || type === 'maverickv1' || type === 'maverickv2' ||
    type === 'curve_stableng' || type === 'hydrex' || type === 'unipool'
  ) {
    return getPairMidAtBlock(client, tokenIn, tokenOut, blockNumber, decimalsOf);
  }
```

with:

```ts
  // RFQ fills are quoted off-chain — there is no pool mid to read. Deliberate
  // null (decomposeRoute skips rfq legs before its midReader; this guard keeps
  // any other caller honest).
  if (type === 'rfq') return null;

  // Unknown, plus venues whose own mid we cannot read directly
  // (non-v3 math or no price getter) -- use factory discovery
  if (
    type === 'unknown' || type === 'maverickv1' || type === 'maverickv2' ||
    type === 'curve_stableng' || type === 'hydrex' || type === 'unipool'
  ) {
    return getPairMidAtBlock(client, tokenIn, tokenOut, blockNumber, decimalsOf);
  }
```

- [ ] **Step 4: Run the full core suite**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src`
Expected: ALL pass (re-measure the count; do not quote a remembered one). If any pre-existing tokenPricing test asserted factory discovery for `'rfq'`, that assertion documents the OLD accident — flag it in your report rather than silently changing expectations, unless the test name/comment shows it is a generic type-routing table check, in which case update it to expect null and say so.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx tsc --build && git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts packages/core/src/tokenPricing.ts && git commit -m "feat(core): rfq legs are deliberately unpriced — skip mids, gate recon, no downgrade

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: RPC e2e pins (real maker txs)

**Files:**
- Test: `packages/core/src/analyzeTransaction.test.ts` (inside the existing `describe.runIf(RPC)('analyzeTransaction (integration)', …)` block)

**Interfaces:**
- Consumes: full pipeline from Tasks 1-2; stored `routeLegs[].type` / `routeLegs[].priceImpactBps`; flag prefix `RFQ_LEG_UNPRICED`.
- Produces: nothing downstream — verification gate.

- [ ] **Step 1: Write the two e2e tests**

```ts
	it('types the 0x Settler maker leg rfq and prices around it (id 189 follow-on)', async () => {
		const r = await analyzeTransaction(
			'0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const maker = r!.routeLegs.find((l) => l.venue === '0x69a9f156d5902191dce331ab348f3e9e96e48b22');
		expect(maker).toBeDefined();
		expect(maker!.type).toBe('rfq');
		expect(maker!.priceImpactBps).toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(true);
		// The maker leg must not carry a garbage AMM benchmark anymore…
		expect(r!.normalizeFlags.some((f) => f.startsWith('PI_IMPLAUSIBLE') && f.includes('0x69a9f156'))).toBe(false);
		// …and the netting-era reconstruction must still hold.
		expect(r!.lpFeeBps).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
	}, 60_000);

	it('types an EOA limit-order maker leg rfq (row 118 pin)', async () => {
		const r = await analyzeTransaction(
			'0x1bc9fb0965659a9768c3f71f7ea57bbe41a25682416dcfc3652baf5b10364e69',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const maker = r!.routeLegs.find((l) => l.venue === '0x7d94baf661d5ed8ad30d7241d1a50f3883083ef7');
		expect(maker).toBeDefined();
		expect(maker!.type).toBe('rfq'); // bare EOA → tier 2
		expect(maker!.priceImpactBps).toBeNull();
	}, 60_000);
```

- [ ] **Step 2: Run with the RPC exported**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && set -a && source .env && set +a && npx vitest run packages/core/src/analyzeTransaction.test.ts`
Expected: PASS, and the output must show the integration block RAN (pass/skip counts — `describe.runIf` silently skips without `TCA_RPC_URL`; a skip is NOT a pass). Paste the counts line into your report.

**CHECKPOINT — if either test fails:** do NOT weaken assertions, do NOT touch production code. Report BLOCKED with the complete verbatim failure output; the real txs have a wrinkle the synthetics don't model.

- [ ] **Step 3: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && git add packages/core/src/analyzeTransaction.test.ts && git commit -m "test(core): e2e-pin rfq maker typing on the 0x Settler and 1inch LOP txs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: dashboard — "Market Maker" label + tooltip

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx` (`getVenueLabel`, ~:593-614)
- Modify: `packages/dashboard/components/ReceiptView.tsx` (`LegRow`, ~:339-370)
- Test: `packages/dashboard/components/TradesTable.test.tsx`, `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: stored `RouteLeg.type === 'rfq'` (already flows through `routeLegsBase`); `BkdRow`'s existing `tooltip` prop.
- Produces: label "Market Maker"; tooltip string "Filled from a market maker's inventory at an off-chain quoted price; no pool fee or on-chain mid exists for this hop."

- [ ] **Step 1: Write the failing tests**

In `packages/dashboard/components/TradesTable.test.tsx` (match the file's existing test style for `getVenueLabel` if present, else add):

```ts
	it('labels rfq legs Market Maker and unknown legs Unknown Pool', () => {
		expect(getVenueLabel({ type: 'rfq', venue: '0x69a9f156d5902191dce331ab348f3e9e96e48b22' })).toBe('Market Maker');
		expect(getVenueLabel({ type: 'unknown', venue: '0x51c72848c68a965f66fa7a88855f9f7784502a7f' })).toBe('Unknown Pool');
	});
```

In `packages/dashboard/components/ReceiptView.test.tsx`, following the file's existing `renderToStaticMarkup` pattern for receipt fixtures: render a `Receipt` whose `routeLegs` contains one leg with `type: 'rfq'` (clone the smallest existing routeLegs fixture row and set `type`), and assert:

```ts
		expect(html).toContain('Market Maker');
		expect(html).toContain('Filled from a market maker');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/dashboard/components/TradesTable.test.tsx packages/dashboard/components/ReceiptView.test.tsx`
Expected: FAIL — `getVenueLabel` returns 'Unknown Pool' for rfq; the tooltip string is absent.

- [ ] **Step 3: Implement**

3a. `TradesTable.tsx` `getVenueLabel` — replace the aliased line:

```ts
	if (leg.type === 'rfq' || leg.type === 'unknown') return 'Unknown Pool';
```

with:

```ts
	if (leg.type === 'rfq') return 'Market Maker';
	if (leg.type === 'unknown') return 'Unknown Pool';
```

3b. `ReceiptView.tsx` — module-level constant near the other copy strings:

```ts
const RFQ_LEG_TOOLTIP =
	"Filled from a market maker's inventory at an off-chain quoted price; no pool fee or on-chain mid exists for this hop.";
```

and in `LegRow`'s `<BkdRow …>` add (matching how optional props are conditionally spread elsewhere in the file):

```ts
			{...(leg.type === 'rfq' ? { tooltip: RFQ_LEG_TOOLTIP } : {})}
```

- [ ] **Step 4: Run the dashboard tests, then the full repo suite**

Run: `cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/dashboard/components/TradesTable.test.tsx packages/dashboard/components/ReceiptView.test.tsx && npx vitest run`
Expected: ALL pass.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx tsc --build && git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx && git commit -m "feat(dashboard): label rfq legs Market Maker with an off-chain-quote tooltip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: corpus dry run + in-place repopulation (CONTROLLER-RUN — do not delegate DB writes)

**Files:**
- Create: `<scratchpad>/repopulate-rfq.mjs` (ad-hoc, NOT committed)
- No repo source changes.

**Interfaces:**
- Consumes: compiled core (`packages/core/dist/index.js` after `npx tsc --build`), `postgres` from repo `node_modules`, `.env` credentials.
- Produces: updated rows (ids preserved) for the maker corpus.

- [ ] **Step 1: Compile core** — `npx tsc --build` (NEVER `npm run build`).

- [ ] **Step 2: Adapt the netting-era dry-run script** (same skeleton as the 2026-07-16 netting rollout) with TWO changes: (a) the comparator must also detect retype-only changes — add to `cmp`: `['recon_residual_bps', row.recon_residual_bps, num(r.reconResidualBps)]` and `['leg_types', (row.route_legs ?? []).map((l) => l.type).join(','), r.routeLegs.map((l) => l.type).join(',')]`; (b) `--write <id>` may be passed multiple times (or accept `--write-all-expected`), updating the same column set as the netting script PLUS nothing new (the columns already cover route_legs/normalize_flags/decomp_confidence/recon_residual_bps).

- [ ] **Step 3: Dry run.** Expected: changed rows are a SUBSET of {36, 47, 53, 60, 64, 118, 189} — leg types `unknown`→`rfq` on the maker venues (`0xbee3211a…` rows 36/47, `0x3dbe077e…` rows 53/64 and possibly 60, `0x7d94baf6…` row 118, `0x69a9f156…` row 189), maker-leg PI → null, recon → null where it was set (rows 36/53/118), confidence may RISE where the defaulted-fee penalty was the only downgrade. `0x51c72848` (row 189) must remain `unknown` and its `PI_IMPLAUSIBLE` may persist. **Any change outside that set → STOP, report, do not write.**

- [ ] **Step 4: Write each changed row in place; re-run dry run expecting 0 diffs.**

- [ ] **Step 5: Post-write checks:** for each written row assert `all_in ≈ lp + agg + slippage` (< 0.01 bps residual) via a one-off query; confirm `select count(*) filter (where route_legs::text like '%\"rfq\"%') from receipts` matches the written set.

---

## Self-Review Notes

- Spec coverage: detection (Task 1), cost semantics incl. tokenPricing guard (Task 2), e2e pins from the spec's Testing §3 (Task 3), display §Display (Task 4), rollout §Rollout (Task 5). Out-of-scope items have no tasks — intentional.
- Type consistency: `rfqProbe` union `'eoa' | 'proxy1967' | 'contract'` used identically in Tasks 1-2 tests; flag prefix `RFQ_LEG_UNPRICED` and label "Market Maker" quoted verbatim everywhere.
- Result-shape note for test writers: `decomposeRoute(...).legs` items are `{ leg: Leg, feeTierBps, notionalUsdc, lpFeeBps, priceImpactBps, … }` — venue/type live under `.leg`, priceImpact at the top level (matches existing tests).
- Row 60's stored legs currently show no `unknown` maker leg (complex-slice artifact) — hence the SUBSET gate in Task 5 rather than an exact set.
