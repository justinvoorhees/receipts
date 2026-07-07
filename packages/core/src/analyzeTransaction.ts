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
 * Aggregator/venue labels come from `labelAddress` (unknown → raw address).
 * The whole body is wrapped in try/catch → `null` on ANY failure (never throws).
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type { Direction } from './decoder.js';
import { extractEndpoints, type TraceNode } from './endpoints.js';
import { priceReceipt } from './pricing.js';
import { labelAddress } from './tagging.js';
import { decomposeRoute, createDefaultMidReader } from './decomposeRoute.js';
import { signedDeviationBps } from './priceMath.js';
import { getBenchmarkMid } from './benchmarkPrice.js';
import { AGGREGATOR_SIGNATURES, settlementEventPresent } from './aggregatorSignatures.js';

const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = 'native';

export interface Receipt {
	txHash: string;
	chainId: number;
	blockNumber: number;
	aggregator: string;
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
	pricingStatus: 'full' | 'partial';
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
		const trader = tx.from.toLowerCase();
		const blockNumber = receipt.blockNumber; // bigint

		// Anchor endpoints on the trader. STRICT clean-2-token rule; null → not a
		// swap we can produce a receipt for.
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
		const isFull = pricing.status === 'full';

		// Human amounts (decimals from pricing) and realized output-per-input price.
		const inputAmount = Number(endpoints.inputAmountRaw) / 10 ** pricing.inputDecimals;
		const outputAmount = Number(endpoints.outputAmountRaw) / 10 ** pricing.outputDecimals;
		const realizedPrice = inputAmount > 0 ? outputAmount / inputAmount : null; // output per input

		// All-in cost via the same signed-deviation approach buildSmokeRow uses, in
		// output-per-input convention: (mid − realized)/mid. Positive = cost.
		const marketMid = pricing.marketMid; // output-per-input, or null when partial
		const allInCostBps =
			isFull && marketMid != null && marketMid > 0 && realizedPrice != null
				? signedDeviationBps('sell_weth', marketMid, realizedPrice)
				: null;

		// Gas valued in USD via ETH/USD (best-effort; independent of the traded pair).
		const ethUsd = await bestEffortEthUsd(rpcUrl, blockNumber);
		const gasCostEth = (Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice ?? 0n)) / 1e18;
		const gasCostUsd = ethUsd != null && ethUsd > 0 ? gasCostEth * ethUsd : null;

		// Aggregator label (best-effort; unknown → raw address, never fails).
		const aggregator = tx.to ? labelAddress(tx.to).label : 'unknown';
		const aggSlug = aggregator.toLowerCase();

		// ── decomposeRoute wiring (mirrors normalizeSmokeTrade) ──
		// decompose-trade values WETH flows in USD by multiplying by realizedPrice
		// (USD-per-WETH), so feed it a USD-per-WETH price when WETH is an endpoint;
		// otherwise WETH paths never fire and the value is inert.
		const inLc = endpoints.inputToken.toLowerCase();
		const outLc = endpoints.outputToken.toLowerCase();
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
		const receiptLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics }));
		const sig = AGGREGATOR_SIGNATURES[aggSlug];
		const settlementEventSeen = sig ? settlementEventPresent(receiptLogs, sig) : false;

		const flags = [...route.flags];
		if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${aggSlug}'`);
		if (sig && !settlementEventSeen)
			flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);

		// Compact per-leg representation for storage. Price-impact is a mid-derived
		// field: null it when we only have a partial (LP + Agg) picture.
		const routeLegs = route.legs.map((l) => ({
			venue: l.leg.venue,
			type: l.leg.type,
			tokenIn: l.leg.tokenIn,
			tokenOut: l.leg.tokenOut,
			feeTierBps: l.feeTierBps,
			notionalUsdc: l.notionalUsdc,
			lpFeeBps: l.lpFeeBps,
			priceImpactBps: isFull ? l.priceImpactBps : null,
		}));

		return {
			txHash: txHash.toLowerCase(),
			chainId,
			blockNumber: Number(blockNumber),
			aggregator,
			trader,
			direction: `${pricing.inputSymbol}->${pricing.outputSymbol}`,
			inputToken: endpoints.inputToken,
			outputToken: endpoints.outputToken,
			inputSymbol: pricing.inputSymbol,
			outputSymbol: pricing.outputSymbol,
			inputAmount,
			outputAmount,
			notionalUsd,
			// Mid-derived fields are null on a partial (LP + Agg still valid below).
			realizedPrice: isFull ? realizedPrice : null,
			marketMid: isFull ? marketMid : null,
			allInCostBps: isFull ? allInCostBps : null,
			pricingStatus: pricing.status,
			executionBps: isFull ? route.executionBps : null,
			lpFeeBps: route.lpFeeBps,
			aggFeeBps: route.aggFeeBps,
			slippageBps: isFull ? route.slippageBps : null,
			gasCostUsd,
			routePure: route.routeShape === 'single',
			routeShape: route.routeShape,
			hopCount: route.hopCount,
			routeLegs,
			reconResidualBps: isFull ? route.reconResidualBps : null,
			decompConfidence: route.confidence,
			settlementEventName: sig?.eventName ?? null,
			settlementEventTopic0: sig?.eventTopic0 ?? null,
			settlementEventSeen,
			normalizeFlags: flags,
			// Oracle-validation passthrough (populated only on the WETH/USDC path).
			chainlinkPrice: pricing.chainlinkPrice,
			chainlinkDevBps: null,
			poolDivergenceBps: pricing.poolDivergenceBps,
			manipulationFlag: pricing.manipulationFlag,
			offchainPrice: null,
			offchainDevBps: null,
			chainlinkStalenessSecs: null,
		};
	} catch {
		return null;
	}
}
