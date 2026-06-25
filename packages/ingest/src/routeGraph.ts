/**
 * routeGraph.ts — Pure route-graph reconstruction from token transfers.
 *
 * Given a trade's ERC-20 transfers and known swap venues, reconstructs the
 * ordered swap legs (e.g. USDC→VIRTUAL→WETH) without any I/O.
 *
 * No viem / RPC / DB imports — this module is pure bigint graph logic.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type VenueType = 'univ3' | 'pancakev3' | 'univ4' | 'univ2' | 'aerodrome' | 'rfq' | 'unknown';

export interface Leg {
  venue: string;            // lowercase address (or 'rfq_fill:<idx>')
  type: VenueType;
  tokenIn: string;          // lowercase
  tokenOut: string;         // lowercase
  amountInRaw: bigint;
  amountOutRaw: bigint;
  v4PoolId?: string;        // for univ4 (from Swap event id)
  v4FeeRaw?: number;        // for univ4 (from Swap event fee)
}

export type RouteShape = 'single' | 'linear' | 'split' | 'complex';

export interface RouteGraph {
  legs: Leg[];              // ordered tokenIn→…→tokenOut for linear; best-effort otherwise
  shape: RouteShape;
  inputToken: string;       // trader's input (lowercase)
  outputToken: string;      // trader's output
  tokens: string[];         // all distinct tokens on the path
  reconstructed: boolean;   // false → could not order the path
}

export interface BuildRouteArgs {
  transfers: { token: string; from: string; to: string; value: bigint }[];
  trader: string;
  /** venue address → {type, v4PoolId?, v4FeeRaw?} from Swap-event scan */
  venues: Map<string, { type: VenueType; v4PoolId?: string; v4FeeRaw?: number }>;
  denylist: ReadonlySet<string>;
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

        // amountIn = gross received for tokenIn at this address
        // amountOut = gross sent for tokenOut at this address
        const amountInRaw = addrGross.get(tokenIn)?.received ?? 0n;
        const amountOutRaw = addrGross.get(tokenOut)?.sent ?? 0n;

        const leg: Leg = {
          venue: addr,
          type: knownVenue.type,
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };

        if (knownVenue.v4PoolId) leg.v4PoolId = knownVenue.v4PoolId;
        if (knownVenue.v4FeeRaw !== undefined) leg.v4FeeRaw = knownVenue.v4FeeRaw;

        legs.push(leg);
      }
    } else {
      // Not a known venue — check if it's an RFQ filler:
      // net-received exactly one token and net-sent exactly one other
      if (netReceived.length === 1 && netSent.length === 1) {
        const tokenIn = netReceived[0]!;
        const tokenOut = netSent[0]!;

        const amountInRaw = addrGross.get(tokenIn)?.received ?? 0n;
        const amountOutRaw = addrGross.get(tokenOut)?.sent ?? 0n;

        legs.push({
          venue: addr,
          type: 'rfq',
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        });
      }
    }
  }

  return legs;
}

/**
 * Chain legs into order starting from inputToken → … → outputToken.
 */
function chainLegs(
  legs: Leg[],
  inputToken: string,
  outputToken: string,
): { ordered: Leg[]; shape: RouteShape; reconstructed: boolean } {
  if (legs.length === 0) {
    return { ordered: [], shape: 'complex', reconstructed: false };
  }

  if (legs.length === 1) {
    const leg = legs[0]!;
    if (leg.tokenIn === inputToken && leg.tokenOut === outputToken) {
      return { ordered: [leg], shape: 'single', reconstructed: true };
    }
    return { ordered: [leg], shape: 'complex', reconstructed: false };
  }

  // Try to build a single chain from inputToken to outputToken
  const chain = tryBuildChain(legs, inputToken, outputToken);

  if (chain && chain.length === legs.length) {
    // All legs consumed in one chain
    return { ordered: chain, shape: 'linear', reconstructed: true };
  }

  // Check for split: multiple first-legs starting from inputToken
  const firstLegs = legs.filter(l => l.tokenIn === inputToken);
  if (firstLegs.length > 1) {
    // Clean direct-pair split: every leg swaps inputToken→outputToken directly.
    // Deeper / nested / mixed splits stay reconstructed=false (low confidence).
    const cleanSplit = legs.every(l => l.tokenIn === inputToken && l.tokenOut === outputToken);
    return { ordered: legs, shape: 'split', reconstructed: cleanSplit };
  }

  // Complex / stalled — return best-effort
  return { ordered: chain ?? legs, shape: 'complex', reconstructed: false };
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

  while (currentToken !== outputToken && remaining.size > 0) {
    let found: Leg | null = null;
    for (const leg of remaining) {
      if (leg.tokenIn === currentToken) {
        found = leg;
        break;
      }
    }
    if (!found) return chain.length > 0 ? chain : null;

    chain.push(found);
    remaining.delete(found);
    currentToken = found.tokenOut;
  }

  if (currentToken === outputToken) return chain;
  return chain.length > 0 ? chain : null;
}

// ── Main ───────────────────────────────────────────────────────────────────

export function buildRouteGraph(args: BuildRouteArgs): RouteGraph {
  const traderLc = args.trader.toLowerCase();

  // Normalize venue keys and denylist to lowercase
  const venuesLc = new Map<string, { type: VenueType; v4PoolId?: string; v4FeeRaw?: number }>();
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
    };
  }
  const { inputToken, outputToken } = traderTokens;

  // 3. Build legs from venues + RFQ discovery
  const legs = buildLegs(argsNorm, deltas, gross, traderLc);

  // 4. Chain legs into order
  const { ordered, shape, reconstructed } = chainLegs(legs, inputToken, outputToken);

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
  };
}
