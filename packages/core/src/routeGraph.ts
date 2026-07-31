/**
 * routeGraph.ts — Pure route-graph reconstruction from token transfers.
 *
 * Given a trade's ERC-20 transfers and known swap venues, reconstructs the
 * ordered swap legs (e.g. USDC→VIRTUAL→WETH) without any I/O.
 *
 * No viem / RPC / DB imports — this module is pure bigint graph logic.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type VenueType = 'univ3' | 'sushiv3' | 'baseswapv3' | 'pancakev3' | 'univ4' | 'univ2' | 'aerodrome' | 'aerodrome_cl' | 'curve_stableng' | 'maverickv1' | 'maverickv2' | 'hydrex' | 'quickswapv4' | 'unipool' | 'rfq' | 'unknown' | 'wrap' | 'unwrap' | 'pancake_infinity';

export interface Leg {
  venue: string;            // lowercase address (or 'rfq_fill:<idx>')
  type: VenueType;
  tokenIn: string;          // lowercase
  tokenOut: string;         // lowercase
  amountInRaw: bigint;
  amountOutRaw: bigint;
  /** true → the address had a round-trip in a leg token (e.g. RFQ maker change),
   *  so amounts are net deltas, not gross flows. Absent when gross == net. */
  amountsNetted?: boolean;
  v4PoolId?: string;        // for univ4 (from Swap event id)
  v4FeeRaw?: number;        // for univ4 (from Swap event fee)
  infinityPoolId?: string;  // for pancake_infinity (from Swap event id)
  infinityFeeRaw?: number;  // LP-ONLY pips, already inverted out of swapFee
  /** The address-derived leg these synthesized legs REPLACE. For Uniswap V4 that
   *  is the PoolManager, which both emits Swap and custodies tokens. For
   *  PancakeSwap Infinity the two DIFFER — the CLPoolManager emits, the Vault
   *  custodies — and it is the custodian's leg that must be replaced. Naming it
   *  for its role rather than for V4 is what lets both share the merge logic. */
  replacesVenue?: string;
}

export type RouteShape = 'single' | 'linear' | 'split' | 'complex';

/**
 * Why a leg set could not be reconstructed into a conserved input→output DAG.
 * `orphan_token` (inflow=0, outflow>0) means a leg spends a token no leg
 * produces — an un-modeled venue (e.g. a V4 multi-pool PoolManager). A
 * `fee_on_transfer` intermediate has BOTH flows > 0 but they disagree beyond
 * the conservation tolerance — a taxed token, where the amounts genuinely
 * cannot be trusted for per-leg attribution. `unreconstructed` is the residual
 * (cyclic / disconnected / degenerate) with no single culprit token.
 */
export type RouteBreakReason =
  | { kind: 'fee_on_transfer'; token: string; inflowRaw: bigint; outflowRaw: bigint; gapBps: number }
  | { kind: 'orphan_token'; token: string; outflowRaw: bigint }
  | { kind: 'unreconstructed' };

export interface RouteGraph {
  legs: Leg[];              // ordered tokenIn→…→tokenOut for linear; best-effort otherwise
  shape: RouteShape;
  inputToken: string;       // trader's input (lowercase)
  outputToken: string;      // trader's output
  tokens: string[];         // all distinct tokens on the path
  reconstructed: boolean;   // false → could not order the path
  breakReason?: RouteBreakReason; // set only when reconstructed === false
}

export interface BuildRouteArgs {
  transfers: { token: string; from: string; to: string; value: bigint }[];
  trader: string;
  /** venue address → {type, v4PoolId?, v4FeeRaw?, infinityPoolId?, infinityFeeRaw?} from Swap-event scan */
  venues: Map<string, { type: VenueType; v4PoolId?: string; v4FeeRaw?: number; infinityPoolId?: string; infinityFeeRaw?: number }>;
  denylist: ReadonlySet<string>;
  /** Extra legs synthesized outside address-delta reconstruction (e.g. V4
   *  multi-pool legs from Swap events) — merged with the address-derived legs
   *  before chaining. De-duped against any univ4 leg already captured. */
  extraLegs?: Leg[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

type DeltaMap = Map<string, Map<string, bigint>>; // address → (token → net delta)
type GrossFlows = Map<string, Map<string, { received: bigint; sent: bigint }>>; // address → (token → {received, sent})

function buildDeltas(transfers: BuildRouteArgs['transfers']): { deltas: DeltaMap; gross: GrossFlows } {
  const deltas: DeltaMap = new Map();
  const gross: GrossFlows = new Map();

  for (const t of transfers) {
    const token = t.token.toLowerCase();
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();

    // Net deltas
    if (!deltas.has(from)) deltas.set(from, new Map());
    if (!deltas.has(to)) deltas.set(to, new Map());
    const fromMap = deltas.get(from)!;
    const toMap = deltas.get(to)!;
    fromMap.set(token, (fromMap.get(token) ?? 0n) - t.value);
    toMap.set(token, (toMap.get(token) ?? 0n) + t.value);

    // Gross flows
    if (!gross.has(from)) gross.set(from, new Map());
    if (!gross.has(to)) gross.set(to, new Map());
    const fromGross = gross.get(from)!;
    const toGross = gross.get(to)!;
    if (!fromGross.has(token)) fromGross.set(token, { received: 0n, sent: 0n });
    if (!toGross.has(token)) toGross.set(token, { received: 0n, sent: 0n });
    fromGross.get(token)!.sent += t.value;
    toGross.get(token)!.received += t.value;
  }

  return { deltas, gross };
}

/**
 * Identify trader's input (net-negative) and output (net-positive) tokens.
 */
function identifyTraderTokens(
  deltas: DeltaMap,
  trader: string,
): { inputToken: string; outputToken: string } | null {
  const traderDeltas = deltas.get(trader);
  if (!traderDeltas) return null;

  let inputToken: string | null = null;
  let outputToken: string | null = null;

  for (const [token, delta] of traderDeltas) {
    if (delta < 0n) {
      // Trader sent more than received → input token
      if (inputToken !== null) {
        // Multiple input tokens — pick the one with the largest absolute magnitude
        const existingAbs = -(traderDeltas.get(inputToken)!); // positive
        const currentAbs = -delta; // positive
        if (currentAbs > existingAbs) inputToken = token;
      } else {
        inputToken = token;
      }
    } else if (delta > 0n) {
      // Trader received more than sent → output token
      if (outputToken !== null) {
        // Multiple output tokens — pick the one with the largest absolute magnitude
        const existingAbs = traderDeltas.get(outputToken)!; // already positive
        if (delta > existingAbs) outputToken = token;
      } else {
        outputToken = token;
      }
    }
  }

  if (!inputToken || !outputToken) return null;
  return { inputToken, outputToken };
}

/**
 * Leg amounts for a candidate address. Gross flows are the default measure,
 * with ONE exception: when the address has a round-trip in its OUTPUT token
 * (it received some tokenOut back — e.g. an RFQ maker that paid gross and was
 * given change), gross double-counts the change, so the conserved measure of
 * its production is the net delta. The INPUT side always stays gross: upstream
 * legs deliver gross, and a venue's same-token outflow on its input token
 * (e.g. a V4 hook-fee fanout to fee recipients) leaks to non-participants —
 * it does not reduce what was delivered INTO the venue, so netting it would
 * BREAK conservation (observed on the ZORA leg of 0xb020…9e26).
 * tokenOut is net-sent (delta < 0) by construction in buildLegs, so the
 * negated delta is positive.
 */
function legAmounts(
  addrDeltas: Map<string, bigint>,
  addrGross: Map<string, { received: bigint; sent: bigint }>,
  tokenIn: string,
  tokenOut: string,
): { amountInRaw: bigint; amountOutRaw: bigint; amountsNetted: boolean } {
  const outFlows = addrGross.get(tokenOut) ?? { received: 0n, sent: 0n };
  const outNetted = outFlows.received > 0n; // tokenOut also flowed back in → round-trip
  return {
    amountInRaw: addrGross.get(tokenIn)?.received ?? 0n,
    amountOutRaw: outNetted ? -(addrDeltas.get(tokenOut) ?? 0n) : outFlows.sent,
    amountsNetted: outNetted,
  };
}

/**
 * Build legs from venues (known swap addresses + discovered RFQ fillers).
 */
function buildLegs(
  args: BuildRouteArgs,
  deltas: DeltaMap,
  gross: GrossFlows,
  trader: string,
): Leg[] {
  const legs: Leg[] = [];
  const traderLc = trader.toLowerCase();

  // All addresses that appear in transfers (excluding trader and denylist)
  const candidates = new Set<string>();
  for (const [addr] of deltas) {
    if (addr === traderLc) continue;
    if (args.denylist.has(addr) && !args.venues.has(addr)) continue;
    candidates.add(addr);
  }

  for (const addr of candidates) {
    const addrDeltas = deltas.get(addr)!;
    const addrGross = gross.get(addr)!;

    // Determine if this is a known venue or an RFQ filler
    const knownVenue = args.venues.get(addr);

    // Find net-received tokens (delta > 0) and net-sent tokens (delta < 0)
    const netReceived: string[] = [];
    const netSent: string[] = [];
    for (const [token, delta] of addrDeltas) {
      if (delta > 0n) netReceived.push(token);
      else if (delta < 0n) netSent.push(token);
    }

    if (knownVenue) {
      // Known venue from Swap events — it must have exactly one tokenIn (received)
      // and one tokenOut (sent) to emit a clean leg.
      // Multi-token venues (>1 net-received or >1 net-sent) are skipped here;
      // the missing leg will cause chainLegs to classify the route as 'complex'.
      if (netReceived.length === 1 && netSent.length === 1) {
        const tokenIn = netReceived[0]!;
        const tokenOut = netSent[0]!;

        const { amountInRaw, amountOutRaw, amountsNetted } = legAmounts(addrDeltas, addrGross, tokenIn, tokenOut);

        const leg: Leg = {
          venue: addr,
          type: knownVenue.type,
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };
        if (amountsNetted) leg.amountsNetted = true;

        if (knownVenue.v4PoolId) leg.v4PoolId = knownVenue.v4PoolId;
        if (knownVenue.v4FeeRaw !== undefined) leg.v4FeeRaw = knownVenue.v4FeeRaw;
        if (knownVenue.infinityPoolId) leg.infinityPoolId = knownVenue.infinityPoolId;
        if (knownVenue.infinityFeeRaw !== undefined) leg.infinityFeeRaw = knownVenue.infinityFeeRaw;

        legs.push(leg);
      }
    } else {
      // Not a known venue, but a clean 1-in-1-out flow (net-received exactly one
      // token, net-sent exactly one other). Classified `unknown` — NOT `rfq`:
      // probing showed these are real AMM pools we failed to recognize, so their
      // LP fee stays a flagged (defaulted) guess rather than a confident 0.
      if (netReceived.length === 1 && netSent.length === 1) {
        const tokenIn = netReceived[0]!;
        const tokenOut = netSent[0]!;

        const { amountInRaw, amountOutRaw, amountsNetted } = legAmounts(addrDeltas, addrGross, tokenIn, tokenOut);

        const leg: Leg = {
          venue: addr,
          type: 'unknown',
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };
        if (amountsNetted) leg.amountsNetted = true;
        legs.push(leg);
      }
    }
  }

  return legs;
}

/**
 * Chain legs into order starting from inputToken → … → outputToken.
 */
export function chainLegs(
  legs: Leg[],
  inputToken: string,
  outputToken: string,
): { ordered: Leg[]; shape: RouteShape; reconstructed: boolean; breakReason?: RouteBreakReason } {
  if (legs.length === 0) {
    return { ordered: [], shape: 'complex', reconstructed: false, breakReason: { kind: 'unreconstructed' } };
  }

  if (legs.length === 1) {
    const leg = legs[0]!;
    if (leg.tokenIn === inputToken && leg.tokenOut === outputToken) {
      return { ordered: [leg], shape: 'single', reconstructed: true };
    }
    return { ordered: [leg], shape: 'complex', reconstructed: false, breakReason: diagnoseBreak(legs, inputToken, outputToken) };
  }

  // Try to build a single chain from inputToken to outputToken
  const chain = tryBuildChain(legs, inputToken, outputToken);

  if (
    chain &&
    chain.length === legs.length &&
    chain[chain.length - 1]!.tokenOut === outputToken &&
    linearFlowValid(legs, inputToken, outputToken)
  ) {
    // All legs consumed in one chain ending at the output token
    return { ordered: chain, shape: 'linear', reconstructed: true };
  }

  // Clean direct-pair split: every leg swaps inputToken→outputToken directly.
  const firstLegs = legs.filter(l => l.tokenIn === inputToken);
  if (firstLegs.length > 1 && legs.every(l => l.tokenIn === inputToken && l.tokenOut === outputToken)) {
    return { ordered: legs, shape: 'split', reconstructed: true };
  }

  // General DAG: any conserved, acyclic input→output flow, including convergent
  // multi-hop splits (paths that reconverge at a shared token). Costs are
  // notional-weighted in decomposeRoute so per-leg attribution reconciles.
  const dag = reconstructDag(legs, inputToken, outputToken);
  if (dag) {
    return { ordered: dag, shape: firstLegs.length > 1 ? 'split' : 'complex', reconstructed: true };
  }

  // Complex / stalled — best-effort ordering (unchanged non-reconstructed path).
  let complexOrdered = chain ?? legs;
  if (chain) {
    const stop = chain.findIndex((l) => l.tokenOut === outputToken);
    if (stop >= 0) complexOrdered = chain.slice(0, stop + 1);
  }
  return { ordered: complexOrdered, shape: 'complex', reconstructed: false, breakReason: diagnoseBreak(legs, inputToken, outputToken) };
}

/** Conservation tolerance: intermediate-token inflow vs outflow may differ by
 *  ≤0.1% (rounding/dust between pools). Fee-on-transfer tokens exceed this and
 *  correctly stay non-reconstructed. */
function conserved(inflow: bigint, outflow: bigint): boolean {
  const diff = inflow > outflow ? inflow - outflow : outflow - inflow;
  const max = inflow > outflow ? inflow : outflow;
  return max === 0n ? true : diff * 1000n <= max;
}

/**
 * Classify an unreconstructable leg set. Call ONLY on the non-reconstructed
 * path — a conserved input→output flow returns `unreconstructed` here but would
 * not have reached this function. Pure: mirrors reconstructDag's per-token
 * inflow/outflow accounting, then names the first offending intermediate.
 * Orphan is checked before fee-on-transfer because an orphan (inflow=0) is also
 * technically non-conserving, but the more specific cause is "missing leg".
 */
export function diagnoseBreak(legs: Leg[], inputToken: string, outputToken: string): RouteBreakReason {
  const inflow = new Map<string, bigint>();
  const outflow = new Map<string, bigint>();
  for (const l of legs) {
    outflow.set(l.tokenIn, (outflow.get(l.tokenIn) ?? 0n) + l.amountInRaw);
    inflow.set(l.tokenOut, (inflow.get(l.tokenOut) ?? 0n) + l.amountOutRaw);
  }
  const tokens = new Set<string>([...inflow.keys(), ...outflow.keys()]);
  for (const t of tokens) {
    if (t === inputToken || t === outputToken) continue;
    const inn = inflow.get(t) ?? 0n;
    const out = outflow.get(t) ?? 0n;
    if (inn === 0n && out > 0n) {
      return { kind: 'orphan_token', token: t, outflowRaw: out };
    }
    if (!conserved(inn, out)) {
      const max = inn > out ? inn : out;
      const diff = inn > out ? inn - out : out - inn;
      const gapBps = max === 0n ? 0 : Number((diff * 10_000n) / max);
      return { kind: 'fee_on_transfer', token: t, inflowRaw: inn, outflowRaw: out, gapBps };
    }
  }
  return { kind: 'unreconstructed' };
}

/**
 * Guard for the pre-existing tryBuildChain "linear" fast path: tryBuildChain
 * only checks token-identity linkage (tokenOut[i] === tokenIn[i+1]), not
 * amounts or true cycles, so it can misclassify a non-conserved or cyclic flow
 * as a complete linear walk whenever the walk happens to consume every leg and
 * land on outputToken. This adds the missing amount/cycle validation without
 * touching tryBuildChain's walk itself:
 *  - inputToken must be a net source (outflow > inflow) — it may recur mid-chain
 *    (produced by some leg) as long as it is still net-consumed. A genuine cycle
 *    back to the input nets to zero (outflow ≤ inflow) and is rejected here.
 *  - every OTHER token, except outputToken, must conserve inflow≈outflow.
 *    outputToken is deliberately exempted: an intentional feature lets the output
 *    token recur mid-chain (e.g. WARP→WETH→USDC→WETH). The input is now treated
 *    symmetrically (net source), which is what lets ETH→…→WETH→USDC→WETH→TOSHI
 *    (id 134) reconstruct — the same token legitimately passing through twice.
 */
function linearFlowValid(legs: Leg[], inputToken: string, outputToken: string): boolean {
  const inflow = new Map<string, bigint>();
  const outflow = new Map<string, bigint>();
  for (const l of legs) {
    outflow.set(l.tokenIn, (outflow.get(l.tokenIn) ?? 0n) + l.amountInRaw);
    inflow.set(l.tokenOut, (inflow.get(l.tokenOut) ?? 0n) + l.amountOutRaw);
  }
  // Input is a NET source (may recur mid-chain): net outflow must be positive.
  // Symmetric with the output token, which already may recur (see below).
  if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return false;
  const tokens = new Set<string>([...inflow.keys(), ...outflow.keys()]);
  for (const t of tokens) {
    if (t === inputToken || t === outputToken) continue;
    if (!conserved(inflow.get(t) ?? 0n, outflow.get(t) ?? 0n)) return false;
  }
  return true;
}

/**
 * Reconstruct a general DAG: returns legs topologically ordered when the flow is
 * a conserved path from inputToken (net source — may recur mid-chain) to
 * outputToken (pure sink); null otherwise. Amounts are compared per token in that
 * token's own raw units (cross-token amounts are never mixed).
 */
function reconstructDag(legs: Leg[], inputToken: string, outputToken: string): Leg[] | null {
  const inflow = new Map<string, bigint>();  // token → total received (Σ amountOutRaw ending there)
  const outflow = new Map<string, bigint>(); // token → total sent (Σ amountInRaw starting there)
  for (const l of legs) {
    outflow.set(l.tokenIn, (outflow.get(l.tokenIn) ?? 0n) + l.amountInRaw);
    inflow.set(l.tokenOut, (inflow.get(l.tokenOut) ?? 0n) + l.amountOutRaw);
  }
  const tokens = new Set<string>([...inflow.keys(), ...outflow.keys()]);
  for (const t of tokens) {
    const inn = inflow.get(t) ?? 0n;
    const out = outflow.get(t) ?? 0n;
    if (t === inputToken) { continue; } // net source — validated after the loop
    if (t === outputToken) { if (out !== 0n) return null; continue; } // pure sink
    if (!conserved(inn, out)) return null; // intermediate must balance
  }
  if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return null; // net source
  if ((inflow.get(outputToken) ?? 0n) <= 0n) return null; // output must receive

  // Greedy topological placement: place a leg once its tokenIn is available
  // (the input token, or a token produced by an already-placed leg). Leftover
  // legs ⇒ a cycle or a disconnected component ⇒ not reconstructable.
  const placed: Leg[] = [];
  const remaining = new Set(legs);
  const available = new Set<string>([inputToken]);
  let progress = true;
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const l of [...remaining]) {
      if (available.has(l.tokenIn)) {
        placed.push(l);
        remaining.delete(l);
        available.add(l.tokenOut);
        progress = true;
      }
    }
  }
  return remaining.size === 0 ? placed : null;
}

/**
 * Try to build a linear chain from inputToken to outputToken by following
 * tokenOut → tokenIn links.
 */
function tryBuildChain(
  legs: Leg[],
  inputToken: string,
  outputToken: string,
): Leg[] | null {
  const remaining = new Set(legs);
  const chain: Leg[] = [];
  let currentToken = inputToken;

  while (remaining.size > 0) {
    let found: Leg | null = null;
    for (const leg of remaining) {
      if (leg.tokenIn === currentToken) {
        found = leg;
        break;
      }
    }
    if (!found) break;

    chain.push(found);
    remaining.delete(found);
    currentToken = found.tokenOut;
  }

  // A valid chain ends at the output token; otherwise return the best-effort
  // partial (used only by the complex fallback), never as a linear route.
  if (chain.length > 0 && currentToken === outputToken) return chain;
  return chain.length > 0 ? chain : null;
}

// ── Main ───────────────────────────────────────────────────────────────────

export function buildRouteGraph(args: BuildRouteArgs): RouteGraph {
  const traderLc = args.trader.toLowerCase();

  // Normalize venue keys and denylist to lowercase
  const venuesLc = new Map<string, { type: VenueType; v4PoolId?: string; v4FeeRaw?: number; infinityPoolId?: string; infinityFeeRaw?: number }>();
  for (const [addr, info] of args.venues) {
    venuesLc.set(addr.toLowerCase(), info);
  }
  const denylistLc = new Set<string>();
  for (const addr of args.denylist) {
    denylistLc.add(addr.toLowerCase());
  }
  const argsNorm: BuildRouteArgs = { ...args, trader: traderLc, venues: venuesLc, denylist: denylistLc };

  // 1. Build per-address per-token net deltas and gross flows
  const { deltas, gross } = buildDeltas(args.transfers);

  // 2. Identify trader's input and output tokens
  const traderTokens = identifyTraderTokens(deltas, traderLc);
  if (!traderTokens) {
    return {
      legs: [],
      shape: 'complex',
      inputToken: '',
      outputToken: '',
      tokens: [],
      reconstructed: false,
      breakReason: { kind: 'unreconstructed' },
    };
  }
  const { inputToken, outputToken } = traderTokens;

  // 3. Build legs from venues + RFQ discovery
  const legs = buildLegs(argsNorm, deltas, gross, traderLc);

  // 3b. Merge in any synthesized extra legs (e.g. V4 multi-pool legs from Swap
  // events).
  //
  // When the extras describe MORE THAN ONE distinct V4 pool, buildLegs' own
  // univ4 leg is the collapsed PoolManager artifact: routeVenueScan.ts keys
  // venues by emitter address and the V4 singleton emits for every pool it
  // hosts, so that leg carries only the LAST pool's fee and poolId. The
  // per-pool legs are strictly better information, so they REPLACE it.
  //
  // With one pool (or none) the address-derived leg is trustworthy and the
  // extra is a duplicate — no drop fires, and the pair-based dedup guard below
  // (existingUniv4Pairs) is what stops a single-pool V4 route double-counting.
  const extraPoolIds = new Set(
    (args.extraLegs ?? []).map((l) => l.v4PoolId).filter((id): id is string => id != null),
  );
  // The collapsed leg sits at the ADDRESS that emitted these Swap logs. Match on
  // that, not on the token pair: a multi-hop through V4 collapses to a leg whose
  // pair is the route's ENDPOINTS (USDC→CLAWD), which no individual pool covers,
  // so a pair-scoped drop would leave it in place and double-count the flow. A
  // different univ4-tagged contract has a different address and survives.
  const extraReplacedVenues = new Set(
    (args.extraLegs ?? []).map((l) => l.replacesVenue).filter((a): a is string => a != null),
  );
  const legsAfterV4 =
    extraPoolIds.size > 1
      ? legs.filter((l) => !(l.type === 'univ4' && extraReplacedVenues.has(l.venue)))
      : legs;
  const existingUniv4Pairs = new Set(
    legsAfterV4.filter((l) => l.type === 'univ4').map((l) => `${l.tokenIn}>${l.tokenOut}`),
  );
  // An extra leg whose OWN emitter's collapsed leg was just dropped above must
  // be kept unconditionally: existingUniv4Pairs is a GLOBAL set across every
  // surviving univ4 leg, so if a second, untouched single-pool V4 emitter
  // happens to trade the SAME token pair, pair-only de-dup would wrongly
  // match the extra against that UNRELATED emitter's leg and delete it too —
  // silently erasing this emitter's entire flow while `reconstructed` stays
  // true (the unrelated leg papers over the gap). Scope the de-dup: only an
  // extra whose emitter was NOT dropped (the single-pool case, where that
  // emitter's own address-derived leg is still present and IS the duplicate)
  // goes through the pair check.
  const emitterWasDropped = (emitter: string | undefined): boolean =>
    extraPoolIds.size > 1 && emitter != null && extraReplacedVenues.has(emitter);
  const dedupedExtraLegs = (args.extraLegs ?? []).filter(
    (l) => emitterWasDropped(l.replacesVenue) || !existingUniv4Pairs.has(`${l.tokenIn}>${l.tokenOut}`),
  );
  const allLegs = dedupedExtraLegs.length > 0 ? [...legsAfterV4, ...dedupedExtraLegs] : legsAfterV4;

  // 4. Chain legs into order
  const { ordered, shape, reconstructed, breakReason } = chainLegs(allLegs, inputToken, outputToken);

  // 5. Collect all distinct tokens on the path
  const tokenSet = new Set<string>();
  tokenSet.add(inputToken);
  tokenSet.add(outputToken);
  for (const leg of ordered) {
    tokenSet.add(leg.tokenIn);
    tokenSet.add(leg.tokenOut);
  }

  return {
    legs: ordered,
    shape,
    inputToken,
    outputToken,
    tokens: Array.from(tokenSet),
    reconstructed,
    ...(breakReason ? { breakReason } : {}),
  };
}
