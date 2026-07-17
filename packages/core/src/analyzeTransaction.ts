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

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type { Direction } from './decoder.js';
import { extractEndpoints, type TraceNode } from './endpoints.js';
import { readTokenUsd } from './tokenOracle.js';
import { priceReceipt, createDefaultPricingDeps } from './pricing.js';
import { decomposeRoute, createDefaultMidReader } from './decomposeRoute.js';
import { signedDeviationBps, isImplausibleDeviationBps } from './priceMath.js';
import { getBenchmarkMid } from './benchmarkPrice.js';
import { AGGREGATOR_SIGNATURES, matchSettlementEvent } from './aggregatorSignatures.js';
import { resolveAggregator } from './resolveAggregator.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveTrader, anchorFlags } from './resolveTrader.js';
import { loadReactors } from './settlementDecoders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REACTORS = await loadReactors(path.resolve(__dirname, '../../../configs/reactors.json'));

const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = 'native';

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

/** Stablecoins that anchor a receipt directly to USD (~$1), mirroring pricing.ts. */
const STABLECOINS: ReadonlySet<string> = new Set([
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
	'0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
	'0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
]);

/** USD-anchor strength: stablecoin > WETH > everything else. The quote leg is
 *  the stronger anchor; the weaker one is the volatile "base" we quote a price
 *  for (e.g. WETH in a USDC/WETH pair). */
function anchorRank(token: string): number {
	const t = token.toLowerCase();
	if (STABLECOINS.has(t)) return 2;
	// Native ETH ('native') is the same reference asset as WETH — anchor it
	// identically so ETH→token trades orient like the equivalent WETH→token.
	if (t === WETH || t === NATIVE) return 1;
	return 0;
}

/**
 * True when the price's base (volatile) leg is the OUTPUT token — i.e. a
 * buy-side trade like USDC→WETH. Stored realized/mid prices are output-per-input;
 * when the base is the output they must be inverted to reach the display
 * convention (USD-per-base). Ties (both legs anchor equally) → false (no invert).
 */
export function baseIsOutputLeg(inputToken: string, outputToken: string): boolean {
	return anchorRank(outputToken) < anchorRank(inputToken);
}

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

export interface Receipt {
	txHash: string;
	chainId: number;
	blockNumber: number;
	aggregator: string;
	/** The contract the taker called (tx.to, lowercased) — the aggregator's
	 *  router for this specific trade. Null only for contract creations. */
	routerAddress: string | null;
	trader: string;
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
	allInCostBps: number | null;
	pricingStatus: 'full' | 'estimated' | 'partial';
	executionBps: number | null;
	lpFeeBps: number | null;
	aggFeeBps: number | null;
	slippageBps: number | null;
	gasCostUsd: number | null;
	routePure: boolean | null;
	routeShape: string | null;
	hopCount: number | null;
	routeLegs: unknown[] | null;
	reconResidualBps: number | null;
	decompConfidence: string | null;
	feeRecipient: string | null;
	feeSinkSource: string | null;
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
	/** Independent Chainlink USD price of the non-anchored side (e.g. WBTC via
	 *  BTC/USD), when that token has a mapped feed; null otherwise. Lets the
	 *  dashboard value that side as a true anchor rather than marking it at mid. */
	anchorPriceUsd: number | null;
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

export async function analyzeTransaction(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string },
): Promise<Receipt | null> {
	const { rpcUrl } = opts;
	try {
		const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
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
				? signedDeviationBps('sell_weth', marketMid, realizedPrice)
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

		// Independent Chainlink USD price for whichever side has a mapped feed
		// (the non-anchored side, e.g. WBTC via BTC/USD). Never-throw; null when
		// neither side is mapped or the read fails/stale.
		const anchorPriceUsd =
			(await readTokenUsd(endpoints.inputToken, blockNumber, rpcUrl)) ??
			(await readTokenUsd(endpoints.outputToken, blockNumber, rpcUrl));

		// Gas valued in USD via ETH/USD (best-effort; independent of the traded pair).
		const ethUsd = await bestEffortEthUsd(rpcUrl, blockNumber);
		const gasCostEth = (Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice ?? 0n)) / 1e18;
		const gasCostUsd = ethUsd != null && ethUsd > 0 ? gasCostEth * ethUsd : null;

		// Aggregator identity: Deployer registry → curated routers → unknown.
		// Never inferred from event topics; see resolveAggregator.ts.
		const resolution = resolveAggregator(tx.to ?? null, receiptLogs);
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
		// direction/settledIn are vestigial in decompose-trade (interface-only), but
		// we derive faithful values for the WETH case anyway.
		const decompDirection: Direction = outLc === WETH ? 'buy_weth' : 'sell_weth';
		const settledIn: 'WETH' | 'ETH' = outLc === NATIVE ? 'ETH' : 'WETH';

		const { midReader, decimalsReader } = createDefaultMidReader(rpcUrl, blockNumber);
		const route = await decomposeRoute(
			{
				trace: trace as never,
				txHash,
				trader,
				direction: decompDirection,
				settledIn,
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
		const routeLegsBase = route.legs.map((l) => ({
			venue: l.leg.venue,
			type: l.leg.type,
			tokenIn: l.leg.tokenIn,
			tokenOut: l.leg.tokenOut,
			feeTierBps: l.feeTierBps,
			notionalUsdc: l.notionalUsdc,
			lpFeeBps: l.lpFeeBps,
			priceImpactBps: midReliable ? l.priceImpactBps : null,
		}));

		// Resolve a display symbol for every leg token — including intermediate hops
		// (e.g. USDT) that are neither an endpoint nor in the dashboard's static map,
		// which would otherwise render as a hash. Seed native + the trade endpoints
		// (no RPC), then read symbol() on-chain for the rest, best-effort: an
		// unresolved token is omitted so the UI falls back to a short address.
		const symbolMap = new Map<string, string>([
			[NATIVE, 'ETH'],
			[endpoints.inputToken.toLowerCase(), pricing.inputSymbol],
			[endpoints.outputToken.toLowerCase(), pricing.outputSymbol],
		]);
		const symbolReader = createDefaultPricingDeps(rpcUrl).readSymbol;
		for (const leg of routeLegsBase) {
			for (const tok of [leg.tokenIn.toLowerCase(), leg.tokenOut.toLowerCase()]) {
				if (symbolMap.has(tok)) continue;
				try {
					symbolMap.set(tok, await symbolReader(tok));
				} catch {
					/* leave unresolved → attachLegSymbols omits it → UI short-address fallback */
				}
			}
		}
		const routeLegs = attachLegSymbols(routeLegsBase, (a) => symbolMap.get(a.toLowerCase()));

		return {
			txHash: txHash.toLowerCase(),
			chainId,
			blockNumber: Number(blockNumber),
			aggregator,
			routerAddress: tx.to ? tx.to.toLowerCase() : null,
			trader,
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
			allInCostBps,
			pricingStatus: midReliable ? pricing.status : 'partial',
			executionBps: midReliable ? route.executionBps : null,
			lpFeeBps: route.lpFeeBps,
			aggFeeBps: route.aggFeeBps,
			slippageBps: midReliable ? route.slippageBps : null,
			gasCostUsd,
			routePure: route.routeShape === 'single',
			routeShape: route.routeShape,
			hopCount: route.hopCount,
			routeLegs,
			reconResidualBps: midReliable ? route.reconResidualBps : null,
			decompConfidence: route.confidence,
			feeRecipient: route.feeRecipient,
			feeSinkSource: route.feeSinkSource,
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
			anchorPriceUsd,
		};
	} catch {
		return null;
	}
}
