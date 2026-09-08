/**
 * analyzeTransaction.ts — the single public, on-demand entry point.
 *
 * Given a pasted transaction hash, produce a `Receipt` describing that swap's
 * execution quality, or `null` when we cannot produce one (bad hash, not a
 * clean 2-token swap, unpriceable, etc. — surfaces in the UI as the single
 * "Transaction not found." error).
 *
 * This is the on-demand replacement for the batch-era `normalizeSmokeTrade`.
 * It reuses that file's proven wiring — `decomposeRoute` + `createDefaultMidReader`,
 * the gas-cost math, and the settlement-event / `normalizeFlags` logic — but
 * generalizes the three hard-coded assumptions of the smoke era:
 *   - trader is `tx.from` (not a known v1 EOA),
 *   - endpoints come from `extractEndpoints` (any pair, not USDC/WETH net-delta),
 *   - pricing comes from `priceReceipt` (graceful full/partial, not WETH/USDC only).
 *
 * Aggregator identity comes from `resolveAggregator` (0x Deployer registry →
 * curated routers → unknown; never inferred from event topics). Venue labels
 * still come from `labelAddress` via decomposeRoute (unknown → raw address).
 * The whole body is wrapped in try/catch → `null` on ANY failure (never throws).
 */

import { createPublicClient } from 'viem';
import { runInDecodeSession, sessionHttp } from './rpcSession.js';
import { base } from 'viem/chains';
import { extractEndpoints, type TraceNode } from './endpoints.js';
import { priceReceipt, createSymbolReader } from './pricing.js';
import { decomposeRoute, type FeeSinkOut } from './decomposeRoute.js';
import { createDefaultMidReader } from './routeReaders.js';
import { signedDeviationBps, isImplausibleDeviationBps } from './priceMath.js';
import { getBenchmarkMid } from './benchmarkPrice.js';
import { AGGREGATOR_SIGNATURES, matchSettlementEvent } from './aggregatorSignatures.js';
import { resolveAggregatorDeep } from './resolveAggregator.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveTrader, anchorFlags, type Anchor } from './resolveTrader.js';
import { loadReactors, loadEntryPoints } from './settlementDecoders.js';
import { extractFrameChains } from './legFrameChains.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REACTORS = await loadReactors(path.resolve(__dirname, '../../../configs/reactors.json'));
const ENTRY_POINTS = await loadEntryPoints(path.resolve(__dirname, '../../../configs/entrypoints.json'));

import { WETH, NATIVE, baseIsOutputLeg } from './receiptPure.js';

/** Aggregator slug for Fabric's own router. */
const FABRIC_AGGREGATOR_SLUG = 'fabric';
/** Fabric's own protocol fee is 0 bps by default and capped at 10 bps (surplus
 *  sharing only — docs.withfabric.xyz/apis/quotes/fees). A fee above this cap
 *  routed through the Fabric router is definitionally an integrator's forwarded
 *  `feeBps`, not Fabric revenue. */
const FABRIC_MAX_PROTOCOL_FEE_BPS = 10;

/**
 * Split a Fabric-routed trade's total retained fee into integrator vs Fabric
 * attribution. Only meaningful for the `fabric` aggregator; other aggregators
 * return nulls (their fee model differs and is presented under their own label).
 *
 *  - fee > 10 bps  → integrator's forwarded feeBps; Fabric earned 0.
 *  - fee 0–10 bps  → ambiguous on-chain (Fabric surplus-share vs a small
 *                    integrator fee) → both null (don't attribute without proof).
 *  - fee = 0 / null → both null.
 */
export function splitFabricFee(
	aggregatorSlug: string,
	aggFeeBps: number | null,
): { integratorFeeBps: number | null; fabricFeeBps: number | null } {
	if (aggregatorSlug.toLowerCase() !== FABRIC_AGGREGATOR_SLUG) {
		return { integratorFeeBps: null, fabricFeeBps: null };
	}
	if (aggFeeBps != null && aggFeeBps > FABRIC_MAX_PROTOCOL_FEE_BPS) {
		return { integratorFeeBps: aggFeeBps, fabricFeeBps: 0 };
	}
	return { integratorFeeBps: null, fabricFeeBps: null };
}

// Anchor strength (anchorRank) and `baseIsOutputLeg` now live in the pure leaf
// receiptPure.ts (imported above) — one definition shared with pricing + the dashboard.

/**
 * Re-orient an output-per-input price into the receipt display convention —
 * USD-per-base (quote-per-base), matching seed rows so the UI reads prices
 * uniformly. Inverts only when the base is the output leg. Cost math stays in
 * output-per-input; only display fields use this. A non-positive price that
 * cannot be inverted degrades to null.
 */
export function toDisplayPrice(price: number | null, baseIsOutput: boolean): number | null {
	if (price == null) return null;
	if (!baseIsOutput) return price;
	return price > 0 ? 1 / price : null;
}

/**
 * Attach a display symbol to each leg's tokenIn/tokenOut. `symbolFor` returns a
 * resolved symbol or `undefined`; when undefined the field is omitted so the
 * dashboard falls back to its own resolution (endpoint map → static map → short
 * address). Pure over the resolver so it's unit-testable without RPC.
 */
/**
 * Flatten one decomposed leg into the RouteLeg shape the dashboard renders
 * (packages/dashboard/lib/legRouterEnrichment.ts's `RouteLeg`). Computed fresh
 * on every /tx render, never persisted — the name predates database removal.
 *
 * Two fields are OMITTED rather than nulled when absent, so a leg missing them
 * for a legitimate reason (below) reads identically either way:
 *   - `frameChain` — absent means "no router attribution"
 *   - `feeResolved` — absent means "the fee tier resolved"; only an explicit
 *     `false` marks a tier we could not read. Without it a 0 bps fee is
 *     indistinguishable from a genuinely free pool and the receipt renders a
 *     confident "0.00bps" (see routeReaders' `unresolvedFee`).
 *
 * Pure over its inputs so this output contract is unit-testable without RPC.
 */
export function toPersistedLeg(
	l: {
		leg: { venue: string; type: string; tokenIn: string; tokenOut: string; replacesVenue?: string };
		feeTierBps: number;
		notionalUsdc: number;
		lpFeeBps: number | null;
		priceImpactBps: number | null;
		feeResolved?: boolean;
	},
	frameChain: string[] | undefined,
) {
	return {
		venue: l.leg.venue,
		type: l.leg.type,
		tokenIn: l.leg.tokenIn,
		tokenOut: l.leg.tokenOut,
		feeTierBps: l.feeTierBps,
		notionalUsdc: l.notionalUsdc,
		lpFeeBps: l.lpFeeBps,
		/*
		  ⚠️ Deliberately NOT gated on `midReliable`, and there used to be a
		  `midReliable ? … : null` here.

		  Per-leg price impact is measured against the LEG'S OWN pool mid at N-1
		  (decomposeRoute step 9) — it never touches the market ruler, so an absent
		  or implausible reference mid says nothing about it. Nulling it here
		  discarded a measurement already made and, because the value never reached
		  the receipt, made the entire Price Impact section unrenderable on any
		  depth-floored receipt no matter what the UI did. Caught by the RPC e2e:
		  0x7e21b6dc lost a real 61.14bps, 0x1955c578 lost 0.34 and 20.05bps.

		  The WHOLE-TRADE quantities stay gated on `midReliable` further down
		  (allInCostBps, executionBps, slippageBps, reconResidualBps) — those really
		  are measured against the ruler and must die with it.
		*/
		priceImpactBps: l.priceImpactBps,
		...(frameChain ? { frameChain } : {}),
		...(l.feeResolved === false ? { feeResolved: false as const } : {}),
		// A synthesized V4 leg's `venue` is `v4:<poolId>`, which is not an address:
		// a Basescan link built from it is dead. Persist the singleton that emitted
		// the Swap so the UI has something real to link to. Omitted on every other
		// leg, whose venue IS the address.
		...(l.leg.replacesVenue ? { v4Emitter: l.leg.replacesVenue } : {}),
	};
}

/**
 * Resolve a display symbol for every leg token — including intermediate hops
 * (e.g. USDT) that are neither an endpoint nor in the dashboard's static map and
 * would otherwise render as a hash.
 *
 * `seed` carries what is already known without RPC (native, plus the trade's two
 * endpoints, whose symbols pricing has already resolved); everything else is
 * read on-chain, all at once. Each distinct token is read exactly once no matter
 * how many legs it appears on.
 *
 * Best-effort by contract: a token whose `symbol()` reverts is OMITTED rather
 * than defaulted, so attachLegSymbols leaves the field unset and the UI falls
 * back to a short address.
 *
 * Pure over the reader so the fan-out and the omit-on-failure rule are testable
 * without RPC.
 */
export async function resolveLegSymbols(
	legs: { tokenIn: string; tokenOut: string }[],
	seed: ReadonlyMap<string, string>,
	readSymbol: (token: string) => Promise<string>,
): Promise<Map<string, string>> {
	const resolved = new Map(seed);
	const wanted = new Set<string>();
	for (const leg of legs) {
		for (const tok of [leg.tokenIn.toLowerCase(), leg.tokenOut.toLowerCase()]) {
			if (!resolved.has(tok)) wanted.add(tok);
		}
	}

	const tokens = [...wanted];
	const symbols = await Promise.all(
		tokens.map((tok) => readSymbol(tok).catch(() => null)),
	);
	for (const [i, tok] of tokens.entries()) {
		const sym = symbols[i];
		if (sym != null) resolved.set(tok, sym);
	}
	return resolved;
}

export function attachLegSymbols<T extends { tokenIn: string; tokenOut: string }>(
	legs: T[],
	symbolFor: (address: string) => string | undefined,
): (T & { tokenInSymbol?: string; tokenOutSymbol?: string })[] {
	return legs.map((l) => {
		const tokenInSymbol = symbolFor(l.tokenIn);
		const tokenOutSymbol = symbolFor(l.tokenOut);
		return {
			...l,
			...(tokenInSymbol ? { tokenInSymbol } : {}),
			...(tokenOutSymbol ? { tokenOutSymbol } : {}),
		};
	});
}

/**
 * The filler/relayer EOA that submitted the transaction, exposed only for
 * UniswapX-anchored trades (resolveTrader tier 2) — self- and net-flow-
 * anchored trades have no separate "filler" concept, so this is null. Pure
 * so it's unit-testable without a live RPC call.
 */
export function deriveFillerAddress(anchor: Anchor, txFrom: string): string | null {
	return anchor.kind === 'beneficiary' && anchor.method === 'uniswapx' ? txFrom.toLowerCase() : null;
}

export interface Receipt {
	txHash: string;
	chainId: number;
	blockNumber: number;
	aggregator: string;
	/** The contract the taker called (tx.to, lowercased) — the aggregator's
	 *  router for this specific trade. Null only for contract creations. */
	routerAddress: string | null;
	trader: string;
	/** The filler/relayer EOA that submitted the tx, populated only when
	 *  resolveTrader anchored via UniswapX (see deriveFillerAddress); null
	 *  for self- and net-flow-anchored trades. */
	fillerAddress: string | null;
	direction: string;
	inputToken: string;
	outputToken: string;
	inputSymbol: string;
	outputSymbol: string;
	inputAmount: number;
	outputAmount: number;
	notionalUsd: number | null;
	realizedPrice: number | null;
	marketMid: number | null;
	marketMidBefore: number | null;
	marketMidAfter: number | null;
	allInCostBps: number | null;
	pricingStatus: 'full' | 'estimated' | 'partial';
	tier: string | null;
	methodology: string | null;
	marketPriceFlags: string[] | null;
	/** Depth of the binding reference pool in USD, populated whether or not the
	 *  depth floor passed — a thin-but-passing ruler must be visible too. */
	referenceDepthUsd: number | null;
	/** The reference pool that depth belongs to. Persisted so the methodology
	 *  sentence can link it and so a receipt's ruler can be re-audited later;
	 *  a depth with no address cannot be checked against anything. */
	referencePoolAddress: string | null;
	executionBps: number | null;
	lpFeeBps: number | null;
	aggFeeBps: number | null;
	slippageBps: number | null;
	gasCostUsd: number | null;
	routePure: boolean | null;
	routeShape: string | null;
	hopCount: number | null;
	routeLegs: unknown[] | null;
	/**
	 * Did the route graph reconstruct? Drives which receipt the UI renders: the
	 * per-leg breakdown, or the "no route available" state where LP Fee, Price
	 * Impact and Third-Party Fee are all N/A. See RouteDecomposeResult.reconstructed
	 * for why neither `routeLegs.length` nor `decompConfidence` answers this.
	 */
	routeReconstructed: boolean;
	reconResidualBps: number | null;
	decompConfidence: string | null;
	feeRecipient: string | null;
	feeSinkSource: string | null;
	feeSinks: FeeSinkOut[];
	integratorFeeBps: number | null;
	fabricFeeBps: number | null;
	settlementEventName: string | null;
	settlementEventTopic0: string | null;
	settlementEventSeen: boolean;
	normalizeFlags: string[];
	chainlinkPrice: number | null;
	chainlinkDevBps: number | null;
	poolDivergenceBps: number | null;
	manipulationFlag: boolean;
	offchainPrice: number | null;
	offchainDevBps: number | null;
	chainlinkStalenessSecs: number | null;
}

/** Best-effort ETH/USD (USDC-per-WETH) to value gas in USD. Never throws —
 *  gas valuation degrading to null must not sink the whole receipt. */
async function bestEffortEthUsd(rpcUrl: string, blockNumber: bigint): Promise<number | null> {
	try {
		const bench = await getBenchmarkMid({ rpcUrl, blockNumber });
		return bench.marketMid > 0 ? bench.marketMid : null;
	} catch {
		return null;
	}
}

/**
 * One call = one decode = one RPC memo (see rpcSession.ts). The session is
 * opened HERE, at the only function that owns a whole receipt, so every read
 * below — pricing, pool discovery, the route readers, the benchmark — dedupes
 * against a store that dies with this call. Opening it any lower would give each
 * layer its own memo and dedupe nothing; opening it any higher (or once per
 * process) would let a `latest`-tagged factory read outlive the request.
 */
export function analyzeTransaction(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string; includeWings?: boolean },
): Promise<Receipt | null> {
	return runInDecodeSession(() => analyzeTransactionInSession(hash, chainId, opts));
}

async function analyzeTransactionInSession(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string; includeWings?: boolean },
): Promise<Receipt | null> {
	const { rpcUrl } = opts;
	try {
		const rpc = createPublicClient({ chain: base, transport: sessionHttp(rpcUrl) });
		const txHash = hash as `0x${string}`;

		const [receipt, tx, rawTrace] = await Promise.all([
			rpc.getTransactionReceipt({ hash: txHash }),
			rpc.getTransaction({ hash: txHash }),
			(rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
				method: 'debug_traceTransaction',
				params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
			}),
		]);

		const trace = rawTrace as TraceNode;
		const receiptLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics }));
		const isEoa = async (a: string): Promise<boolean> => {
			try {
				const code = await rpc.getBytecode({ address: a as `0x${string}` });
				return !code || code === '0x';
			} catch {
				return false; // unknown → contract (conservative)
			}
		};
		const resolved = await resolveTrader({
			trace,
			txFrom: tx.from,
			logs: receiptLogs,
			reactors: REACTORS,
			entryPoints: ENTRY_POINTS,
			isEoa,
		});
		if (!resolved) return null;
		const trader = resolved.trader;
		const blockNumber = receipt.blockNumber; // bigint

		// Anchor endpoints on the trader (now the resolved beneficiary, not
		// necessarily tx.from) — this doubles as the fail-closed check: STRICT
		// clean-2-token rule; null → not a swap we can produce a receipt for.
		const endpoints = extractEndpoints({ trace, trader });
		if (!endpoints) return null;

		// Pricing — never throws; degrades to `partial`.
		const pricing = await priceReceipt({
			rpcUrl,
			blockNumber,
			chainId,
			inputToken: endpoints.inputToken,
			outputToken: endpoints.outputToken,
			inputAmountRaw: endpoints.inputAmountRaw,
			outputAmountRaw: endpoints.outputAmountRaw,
			...(opts.includeWings === undefined ? {} : { includeWings: opts.includeWings }),
		});
		// A market mid exists on both the oracle-validated (full) and best-effort
		// (estimated) tiers. The Execution/Market/Delta rows and the cost
		// decomposition (execution/slippage/recon/per-leg price-impact) all key off
		// THIS, not the oracle-validated `full` status — so the estimated tier
		// surfaces the full breakdown, and only the mid-less `partial` tier nulls it.
		const priced = pricing.marketMid != null;

		// Human amounts (decimals from pricing) and realized output-per-input price.
		const inputAmount = Number(endpoints.inputAmountRaw) / 10 ** pricing.inputDecimals;
		const outputAmount = Number(endpoints.outputAmountRaw) / 10 ** pricing.outputDecimals;
		const realizedPrice = inputAmount > 0 ? outputAmount / inputAmount : null; // output per input

		// All-in cost via the same signed-deviation approach buildSmokeRow uses, in
		// output-per-input convention: (mid − realized)/mid. Positive = cost.
		const marketMid = pricing.marketMid; // output-per-input, or null when partial
		const allInCostBpsRaw =
			marketMid != null && marketMid > 0 && realizedPrice != null
				? signedDeviationBps(marketMid, realizedPrice)
				: null;
		// Safety net: a mid-derived deviation beyond the plausibility cap means the
		// reference mid is garbage (e.g. an empty boundary-tick pool that slipped
		// through pool selection) — degrade to a mid-less `partial` picture instead
		// of surfacing an absurd cost. defaultGetPairMid now rejects the known
		// CLAWNCH case upstream; this is the belt to that suspenders, gating every
		// mid-derived field (marketMid, allInCost, and the whole decomposition).
		const midImplausible = priced && isImplausibleDeviationBps(allInCostBpsRaw);
		const midReliable = priced && !midImplausible;
		const allInCostBps = midReliable ? allInCostBpsRaw : null;

		// Gas valued in USD via ETH/USD (best-effort; independent of the traded pair).
		const ethUsd = await bestEffortEthUsd(rpcUrl, blockNumber);
		const gasCostEth = (Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice ?? 0n)) / 1e18;
		const gasCostUsd = ethUsd != null && ethUsd > 0 ? gasCostEth * ethUsd : null;

		// Aggregator identity: Deployer registry → curated routers → unknown.
		// Never inferred from event topics; see resolveAggregator.ts.
		//
		// `tx.to` is the router for an ordinary swap, but NOT when the entry point
		// is the trader's own 7702-delegated account self-calling `execute`, or an
		// ERC-4337 EntryPoint. resolveAggregatorDeep keeps the tx.to answer whenever
		// it resolves and only then looks down the call tree, so this is additive.
		const resolution = resolveAggregatorDeep({
			to: tx.to ?? null,
			logs: receiptLogs,
			trace,
			notRouters: new Set([trader, ...ENTRY_POINTS]),
		});
		const aggregator = resolution.label;
		const aggSlug = resolution.slug;

		// ── decomposeRoute wiring (mirrors normalizeSmokeTrade) ──
		// decompose-trade values WETH flows in USD by multiplying by realizedPrice
		// (USD-per-WETH), so feed it a USD-per-WETH price when WETH is an endpoint;
		// otherwise WETH paths never fire and the value is inert.
		const inLc = endpoints.inputToken.toLowerCase();
		const outLc = endpoints.outputToken.toLowerCase();
		const baseIsOutput = baseIsOutputLeg(inLc, outLc);
		const notionalUsd = pricing.notionalUsd;
		const wethHuman = inLc === WETH ? inputAmount : outLc === WETH ? outputAmount : null;
		const decompRealizedPrice =
			wethHuman != null && wethHuman > 0 && notionalUsd != null
				? notionalUsd / wethHuman
				: (ethUsd ?? realizedPrice ?? 0);
		const { midReader, decimalsReader } = createDefaultMidReader(rpcUrl, blockNumber);
		const route = await decomposeRoute(
			{
				trace,
				txHash,
				trader,
				// Submitter ≠ trader ⇒ a bundler/relayer; its native credit is a gas
				// reimbursement, not a fee (already counted in gasCostUsd).
				...(tx.from.toLowerCase() === trader ? {} : { gasPayer: tx.from.toLowerCase() }),
				allInCostBps: allInCostBps ?? 0,
				notionalUsdc: notionalUsd ?? 0,
				realizedPrice: decompRealizedPrice,
				gasCostUsd: gasCostUsd ?? 0,
				aggregator,
				blockNumber,
				rpcUrl,
				dustUsdc: 1e-6,
				structuralFloorUsd: 0,
				structuralFloorBps: 0.5,
				recognizeV3Forks: true,
				impureOnVenueThirdToken: true,
			},
			{ midReader, decimalsReader },
		);

		// Settlement-event confirmation + normalizeFlags (mirrors buildSmokeRow).
		const sig = AGGREGATOR_SIGNATURES[aggSlug];
		// Record the topic that actually fired, not the one we expected.
		const matchedTopic = sig ? matchSettlementEvent(receiptLogs, sig) : null;
		const settlementEventSeen = matchedTopic !== null;

		const flags = [...route.flags];
		flags.push(...anchorFlags(resolved.anchor));
		if (midImplausible)
			flags.push(
				`IMPLAUSIBLE_MID: deviation ${allInCostBpsRaw?.toExponential(2)}bps exceeds the plausibility cap — reference mid discarded, degraded to partial`,
			);
		flags.push(`AGGREGATOR_DETECTED_VIA: ${resolution.detectedVia}`);
		for (const hint of resolution.hints)
			flags.push(
				`AGGREGATOR_UNKNOWN_HINT: to=${tx.to} carries ${hint}'s settlement topic — candidate for triage, NOT auto-labeled (it may be a new ${hint} router, or a new aggregator routing through ${hint})`,
			);
		if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${aggSlug}'`);
		// detectBy 'none' means "not topic-detectable by construction" (0x's
		// anonymous log) — a missing event is expected, not a defect.
		if (sig && sig.detectBy !== 'none' && !settlementEventSeen)
			flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);

		// Compact per-leg representation for storage. Price-impact is a mid-derived
		// field: it is meaningful whenever a market mid exists (the full AND
		// estimated tiers), and only genuinely absent on the partial tier (no mid
		// at all — LP + Agg only). Gate on `priced`, not `isFull`, so the estimated
		// tier surfaces the decomposition instead of nulling values decomposeRoute
		// actually computed. Oracle-derived fields stay tier-gated separately.
		// Which call frame executed each leg? `trace` is the one already fetched
		// above — no extra RPC. Raw addresses only; naming happens on read so
		// registry growth is retroactive (see legFrameChains.ts).
		// A synthesized V4 leg's venue is `v4:<poolId>`, never a call-frame address,
		// so keying on it would silently drop router provenance for every V4 leg.
		// Per-leg router names resolve at READ time so a growing routers.json
		// retroactively attributes history — losing the raw frameChain forecloses
		// that permanently. Fall back to the emitting singleton's address.
		const frameKey = (l: { leg: { venue: string; replacesVenue?: string } }): string =>
			(l.leg.replacesVenue ?? l.leg.venue).toLowerCase();
		const venueAddresses = new Set(route.legs.map(frameKey));
		const frameChains = extractFrameChains(trace, venueAddresses);

		const routeLegsBase = route.legs.map((l) =>
			toPersistedLeg(l, frameChains.get(frameKey(l))),
		);

		// Seeded with what costs no RPC: native, plus the endpoints pricing already
		// resolved. See resolveLegSymbols for the fan-out and the omit-on-failure rule.
		const symbolMap = await resolveLegSymbols(
			routeLegsBase,
			new Map<string, string>([
				[NATIVE, 'ETH'],
				[endpoints.inputToken.toLowerCase(), pricing.inputSymbol],
				[endpoints.outputToken.toLowerCase(), pricing.outputSymbol],
			]),
			createSymbolReader(rpcUrl),
		);
		const routeLegs = attachLegSymbols(routeLegsBase, (a) => symbolMap.get(a.toLowerCase()));

		return {
			txHash: txHash.toLowerCase(),
			chainId,
			blockNumber: Number(blockNumber),
			aggregator,
			// The router that actually matched; falls back to tx.to when nothing
			// resolved, so an unresolved row keeps the raw entry point it has today.
			routerAddress: resolution.matchedAddress ?? (tx.to ? tx.to.toLowerCase() : null),
			trader,
			fillerAddress: deriveFillerAddress(resolved.anchor, tx.from),
			direction: `${pricing.inputSymbol}->${pricing.outputSymbol}`,
			inputToken: endpoints.inputToken,
			outputToken: endpoints.outputToken,
			inputSymbol: pricing.inputSymbol,
			outputSymbol: pricing.outputSymbol,
			inputAmount,
			outputAmount,
			notionalUsd,
			// marketMid/allInCostBps are null when no mid exists (partial tier only —
			// LP + Agg fields still valid below). realizedPrice is always populated
			// when inputAmount > 0. Stored in the display convention (USD-per-base) —
			// NOT the raw output-per-input used for the cost math above — so buy-side
			// receipts (USDC→WETH) show USD-per-WETH like seed rows instead of a tiny
			// inverse.
			realizedPrice: toDisplayPrice(realizedPrice, baseIsOutput),
			marketMid: midReliable ? toDisplayPrice(marketMid, baseIsOutput) : null,
			// Same gate, same orientation, same expression shape as marketMid above.
			// These three are one value or none — a triple with a null centre and
			// non-null wings would render a table straddling a mid the receipt
			// refuses to show.
			marketMidBefore:
				midReliable && pricing.marketMidBefore != null
					? toDisplayPrice(pricing.marketMidBefore, baseIsOutput)
					: null,
			marketMidAfter:
				midReliable && pricing.marketMidAfter != null
					? toDisplayPrice(pricing.marketMidAfter, baseIsOutput)
					: null,
			allInCostBps,
			pricingStatus: midReliable ? pricing.status : 'partial',
			tier: midReliable ? pricing.tier : 'none',
			methodology: pricing.methodology,
			marketPriceFlags: pricing.marketPriceFlags,
			// NOT gated on midReliable: a thin-but-passing ruler is exactly the case
			// these fields exist to expose, and it has a perfectly reliable mid.
			referenceDepthUsd: pricing.referenceDepthUsd,
			referencePoolAddress: pricing.referencePoolAddress,
			executionBps: midReliable ? route.executionBps : null,
			lpFeeBps: route.lpFeeBps,
			aggFeeBps: route.aggFeeBps,
			slippageBps: midReliable ? route.slippageBps : null,
			gasCostUsd,
			routePure: route.routeShape === 'single',
			routeShape: route.routeShape,
			hopCount: route.hopCount,
			routeLegs,
			routeReconstructed: route.reconstructed,
			reconResidualBps: midReliable ? route.reconResidualBps : null,
			decompConfidence: route.confidence,
			feeRecipient: route.feeRecipient,
			feeSinkSource: route.feeSinkSource,
			feeSinks: route.feeSinks,
			...splitFabricFee(aggSlug, route.aggFeeBps),
			settlementEventName: sig?.eventName ?? null,
			settlementEventTopic0: matchedTopic,
			settlementEventSeen,
			normalizeFlags: flags,
			// Oracle-validation passthrough (populated only on the WETH/USDC path).
			chainlinkPrice: pricing.chainlinkPrice,
			chainlinkDevBps: pricing.chainlinkDevBps,
			poolDivergenceBps: pricing.poolDivergenceBps,
			manipulationFlag: pricing.manipulationFlag,
			offchainPrice: pricing.offchainPrice,
			offchainDevBps: pricing.offchainDevBps,
			chainlinkStalenessSecs: pricing.chainlinkStalenessSecs,
		};
	} catch {
		return null;
	}
}
