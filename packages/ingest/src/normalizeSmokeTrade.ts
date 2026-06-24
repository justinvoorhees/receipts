/**
 * TRANSFORM — normalize one controlled v1 swap into the v2 cost framework.
 *
 * Known-trader path: we already know the trader EOA (from v1), so we skip the
 * selection gate and the floor/±100 gate entirely. We compute the trader's net
 * USDC + WETH/ETH deltas, derive direction/realizedPrice, look up market mid,
 * run the standard decomposition, and confirm the aggregator's settlement event.
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import {
	USDC, WETH, decodeTransferLogs, collectNativeEthDeltas,
	type Direction,
} from './tradeEndpoints.js';
import { decomposeTrade, type DecomposeResult } from './decompose-trade.js';
import { getReferencePrice } from './referencePrice.js';
import { signedDeviationBps } from './priceMath.js';
import { AGGREGATOR_SIGNATURES, settlementEventPresent } from './aggregatorSignatures.js';

const POOL_5BPS = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const WETH_DUST_RAW = 10_000_000_000n;

export interface SmokeCandidate {
	txHash: `0x${string}`; aggregator: string; trader: `0x${string}`;
	experimentSlug: string; runId: string; v1Status: string;
	v1QuoteAmountUsd: number | null; v1RealizedAmountUsd: number | null;
}
export interface SmokeTradeRow {
	txHash: string; aggregator: string; trader: string;
	direction: Direction; settledIn: 'WETH' | 'ETH';
	usdcAmount: number; wethAmount: number; realizedPrice: number;
	marketMid: number; allInCostBps: number; blockNumber: number;
	lpFeeBps: number | null; aggFeeBps: number; slippageBps: number | null;
	executionBps: number | null; gasCostUsd: number; routePure: boolean;
	experimentSlug: string; runId: string; v1Status: string;
	v1QuoteAmountUsd: number | null; v1RealizedAmountUsd: number | null;
	settlementEventName: string | null; settlementEventTopic0: string | null;
	settlementEventSeen: boolean; normalizeFlags: string[];
}
export type NormalizeResult =
	| { ok: true; row: SmokeTradeRow }
	| { ok: false; aggregator: string; txHash: string; reason: string };

interface TraceNode {
	from?: string; to?: string; value?: string;
	logs?: { address: string; data: string; topics: readonly string[] }[];
	calls?: TraceNode[];
}
const absBI = (n: bigint) => (n < 0n ? -n : n);

function collectTraceLogs(trace: TraceNode): { address: string; data: string; topics: readonly string[] }[] {
	const out: { address: string; data: string; topics: readonly string[] }[] = [];
	const visit = (n: TraceNode) => { if (n.logs) out.push(...n.logs); n.calls?.forEach(visit); };
	visit(trace);
	return out;
}

/** Pure core: build a row from already-fetched trace + decomposition + mid. */
export function buildSmokeRow(args: {
	candidate: SmokeCandidate;
	trace: TraceNode;
	receiptLogs: { address: string; data: string; topics: readonly string[] }[];
	gasUsed: bigint;
	effectiveGasPriceWei: bigint;
	marketMid: number;
	blockNumber: number;
	decomposition: DecomposeResult;
}): NormalizeResult {
	const { candidate: c } = args;
	const trader = c.trader.toLowerCase();
	const transfers = decodeTransferLogs(collectTraceLogs(args.trace) as never);
	const nativeEth = collectNativeEthDeltas(args.trace as never);

	let usdcNet = 0n, wethErc20Net = 0n;
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (t.from.toLowerCase() === trader) {
			if (token === USDC) usdcNet -= t.value; else if (token === WETH) wethErc20Net -= t.value;
		}
		if (t.to.toLowerCase() === trader) {
			if (token === USDC) usdcNet += t.value; else if (token === WETH) wethErc20Net += t.value;
		}
	}
	const ethNet = nativeEth.get(trader) ?? 0n;
	const wethEquivNet = wethErc20Net + ethNet;

	if (usdcNet === 0n || wethEquivNet === 0n) {
		return { ok: false, aggregator: c.aggregator, txHash: c.txHash, reason: 'no_usdc_weth_delta_for_trader' };
	}
	const settledIn: 'WETH' | 'ETH' = absBI(wethErc20Net) > WETH_DUST_RAW ? 'WETH' : 'ETH';
	const direction: Direction = usdcNet < 0n && wethEquivNet > 0n ? 'buy_weth' : 'sell_weth';
	const usdcAmount = Math.abs(Number(usdcNet)) / 1e6;
	const wethAmount = Math.abs(Number(wethEquivNet)) / 1e18;
	const realizedPrice = usdcAmount / wethAmount;
	const allInCostBps = signedDeviationBps(direction, args.marketMid, realizedPrice);

	const gasCostEth = (Number(args.gasUsed) * Number(args.effectiveGasPriceWei)) / 1e18;
	const gasCostUsd = gasCostEth * realizedPrice;

	const sig = AGGREGATOR_SIGNATURES[c.aggregator];
	const settlementEventSeen = sig ? settlementEventPresent(args.receiptLogs, sig) : false;

	const d = args.decomposition;
	const flags = [...d.flags];
	if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${c.aggregator}'`);
	if (sig && !settlementEventSeen) flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);

	return {
		ok: true,
		row: {
			txHash: c.txHash.toLowerCase(), aggregator: c.aggregator, trader,
			direction, settledIn, usdcAmount, wethAmount, realizedPrice,
			marketMid: args.marketMid, allInCostBps, blockNumber: args.blockNumber,
			lpFeeBps: d.lpFeeBps, aggFeeBps: d.aggFeeBps, slippageBps: d.slippageBps,
			executionBps: d.executionBps, gasCostUsd, routePure: d.slippageBps !== null,
			experimentSlug: c.experimentSlug, runId: c.runId, v1Status: c.v1Status,
			v1QuoteAmountUsd: c.v1QuoteAmountUsd, v1RealizedAmountUsd: c.v1RealizedAmountUsd,
			settlementEventName: sig?.eventName ?? null,
			settlementEventTopic0: sig?.eventTopic0 ?? null,
			settlementEventSeen, normalizeFlags: flags,
		},
	};
}

/** Async wrapper: fetch receipt + trace + market mid, run decomposition, build row. */
export async function normalizeSmokeTrade(args: { candidate: SmokeCandidate; rpcUrl: string }): Promise<NormalizeResult> {
	const { candidate: c, rpcUrl } = args;
	try {
		const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
		const [receipt, rawTrace] = await Promise.all([
			rpc.getTransactionReceipt({ hash: c.txHash }),
			(rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
				method: 'debug_traceTransaction',
				params: [c.txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
			}),
		]);
		const trace = rawTrace as TraceNode;
		const blockNumber = Number(receipt.blockNumber);
		const receiptLogs = receipt.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics }));

		const marketMid = await getReferencePrice({ rpcUrl, poolAddress: POOL_5BPS, blockNumber: receipt.blockNumber });

		// Derive trader deltas first to feed decomposeTrade's required inputs.
		const probe = buildSmokeRow({
			candidate: c, trace, receiptLogs,
			gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice,
			marketMid, blockNumber,
			decomposition: { lpFeeBps: null, aggFeeBps: 0, slippageBps: null, executionBps: null, gasBps: 0, hops: [], feeSinks: [], flags: [] },
		});
		if (!probe.ok) return probe;

		const decomposition = await decomposeTrade({
			trace: trace as never,
			txHash: c.txHash,
			trader: probe.row.trader,
			direction: probe.row.direction,
			settledIn: probe.row.settledIn,
			allInCostBps: probe.row.allInCostBps,
			notionalUsdc: probe.row.usdcAmount,
			realizedPrice: probe.row.realizedPrice,
			gasCostUsd: probe.row.gasCostUsd,
			aggregator: capitalizeAgg(c.aggregator),
			blockNumber: receipt.blockNumber,
			rpcUrl,
		});

		return buildSmokeRow({
			candidate: c, trace, receiptLogs,
			gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice,
			marketMid, blockNumber, decomposition,
		});
	} catch (e) {
		return { ok: false, aggregator: c.aggregator, txHash: c.txHash, reason: e instanceof Error ? e.message : String(e) };
	}
}

// decompose-trade.ts keys its vault map by Capitalized names ('Odos','Velora','Relay').
function capitalizeAgg(slug: string): string {
	const map: Record<string, string> = { odos: 'Odos', velora: 'Velora', relay: 'Relay', kyberswap: 'KyberSwap', fabric: 'Fabric', nordstern: 'Nordstern', '0x': '0x', '1inch': '1inch' };
	return map[slug] ?? slug;
}
