/**
 * Verification diagnostic: explain how a single smoke_trades row's cost was
 * decomposed. Re-runs decomposeTrade and prints every venue hop with its fee
 * tier + notional weight, then independently decodes the raw V3 and V4 Swap
 * events (V4's Swap event carries the actual `fee` on-event) so the numbers
 * can be lined up against Basescan. READ-ONLY.
 *
 * Run: set -a && source .env && set +a && TX=0x… npx tsx packages/ingest/src/explain-decomposition.ts
 */
import postgres from 'postgres';
import { createPublicClient, decodeEventLog, http, parseAbiItem, toEventSelector } from 'viem';
import { base } from 'viem/chains';
import { decomposeTrade } from './decompose-trade.js';
import { USDC, WETH, decodeTransferLogs, collectNativeEthDeltas, type Direction } from './tradeEndpoints.js';

const V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const V3_SWAP = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
const V4_SWAP = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
const V4_SWAP_TOPIC = toEventSelector(V4_SWAP);
const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

interface TraceNode { logs?: { address: string; data: string; topics: readonly string[] }[]; calls?: TraceNode[] }
function flatten(t: TraceNode): { address: string; data: string; topics: readonly string[] }[] {
	const out: { address: string; data: string; topics: readonly string[] }[] = [];
	const visit = (n: TraceNode) => { if (n.logs) out.push(...n.logs); n.calls?.forEach(visit); };
	visit(t); return out;
}

async function main(): Promise<void> {
	const txHash = process.env.TX as `0x${string}`;
	if (!txHash) throw new Error('set TX=0x…');
	const rpcUrl = process.env.TCA_RPC_URL!;
	const sql = postgres(process.env.TCA_DATABASE_URL!);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	const [row] = await sql`SELECT * FROM smoke_trades WHERE tx_hash = ${txHash.toLowerCase()}`;
	if (!row) throw new Error(`no smoke_trades row for ${txHash}`);
	const trader = String(row.trader).toLowerCase();

	const rawTrace = await (rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
		method: 'debug_traceTransaction',
		params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
	});
	const trace = rawTrace as TraceNode;
	const receipt = await rpc.getTransactionReceipt({ hash: txHash });
	const logs = flatten(trace);

	console.log(`\n=== ${row.aggregator}  ${txHash} ===`);
	console.log(`stored: Accuracy(-allIn)=${(-Number(row.all_in_cost_bps)).toFixed(2)}bps  LP=${row.lp_fee_bps} Agg=${row.agg_fee_bps} Slip=${row.slippage_bps} gas=$${Number(row.gas_cost_usd).toFixed(4)} routePure=${row.route_pure}`);
	console.log(`realizedPrice=${Number(row.realized_price).toFixed(2)} marketMid=${Number(row.market_mid).toFixed(2)} usdc=${Number(row.usdc_amount).toFixed(4)}`);

	// Re-run decomposition with hops exposed
	const d = await decomposeTrade({
		trace: trace as never, txHash, trader, direction: row.direction as Direction,
		settledIn: row.settled_in as 'WETH' | 'ETH', allInCostBps: Number(row.all_in_cost_bps),
		notionalUsdc: Number(row.usdc_amount), realizedPrice: Number(row.realized_price),
		gasCostUsd: Number(row.gas_cost_usd), aggregator: cap(row.aggregator), blockNumber: BigInt(row.block_number), rpcUrl,
	});
	console.log(`\nDecomposition → lpFeeBps=${d.lpFeeBps} aggFeeBps=${d.aggFeeBps} slippageBps=${d.slippageBps} executionBps=${d.executionBps}`);
	console.log('Venue hops (LP fee is the notional-weighted sum of feeTierBps × pct):');
	for (const h of d.hops) console.log(`  ${h.type.padEnd(4)} ${h.address}  feeTier=${h.feeTierBps}bps  notional=$${h.notionalUsdc.toFixed(4)}  pct=${h.pctOfTotal.toFixed(1)}%`);
	if (d.feeSinks.length) { console.log('Fee sinks:'); for (const s of d.feeSinks) console.log(`  ${s.address} retained=$${s.totalUsdc.toFixed(4)} (${s.source})`); }
	if (d.flags.length) { console.log('Flags:'); for (const f of d.flags) console.log(`  - ${f}`); }

	// Independent decode of raw Swap events → ground truth for fee tiers
	console.log('\nRaw Swap events in tx (independent of the decomposer):');
	let any = false;
	for (const l of logs) {
		const t0 = l.topics[0]?.toLowerCase();
		if (t0 === V3_SWAP_TOPIC && l.topics.length >= 3) {
			any = true;
			try {
				const dec = decodeEventLog({ abi: [V3_SWAP], data: l.data as `0x${string}`, topics: l.topics as never });
				let feeRaw: number | string = 'n/a';
				try { feeRaw = Number(await rpc.readContract({ address: l.address as `0x${string}`, abi: [parseAbiItem('function fee() view returns (uint24)')], functionName: 'fee', blockNumber: BigInt(row.block_number) })); } catch { /* not a static-fee pool */ }
				console.log(`  V3 pool=${l.address} fee()=${feeRaw}raw (${feeRaw === 'n/a' ? '?' : (Number(feeRaw)/100)}bps)  amount0=${dec.args.amount0} amount1=${dec.args.amount1}`);
			} catch { console.log(`  V3 pool=${l.address} (decode failed)`); }
		} else if (t0 === V4_SWAP_TOPIC) {
			any = true;
			try {
				const dec = decodeEventLog({ abi: [V4_SWAP], data: l.data as `0x${string}`, topics: l.topics as never });
				console.log(`  V4 emitter=${l.address} (PoolManager=${l.address.toLowerCase() === V4_POOL_MANAGER}) FEE-ON-EVENT=${dec.args.fee}raw (${Number(dec.args.fee)/100}bps)  amount0=${dec.args.amount0} amount1=${dec.args.amount1}`);
			} catch { console.log(`  V4 emitter=${l.address} (decode failed)`); }
		}
	}
	if (!any) console.log('  (no V3/V4 Swap events — RFQ/executor fill)');

	// Quick transfer ledger for the trader (line up with Basescan token transfers)
	const transfers = decodeTransferLogs(logs as never);
	const nat = collectNativeEthDeltas(trace as never);
	let usdc = 0n, weth = 0n;
	for (const tr of transfers) { const tok = tr.token.toLowerCase(); if (tr.from.toLowerCase() === trader) { if (tok === USDC) usdc -= tr.value; else if (tok === WETH) weth -= tr.value; } if (tr.to.toLowerCase() === trader) { if (tok === USDC) usdc += tr.value; else if (tok === WETH) weth += tr.value; } }
	console.log(`\nTrader net deltas: USDC=${(Number(usdc)/1e6).toFixed(6)}  WETH(erc20)=${(Number(weth)/1e18).toFixed(8)}  nativeETH=${(Number(nat.get(trader)??0n)/1e18).toFixed(8)}`);
	console.log(`Receipt: gasUsed=${receipt.gasUsed} effGasPrice=${receipt.effectiveGasPrice}`);
	await sql.end();
}
function cap(slug: string): string { const m: Record<string,string> = { odos:'Odos', velora:'Velora', relay:'Relay', kyberswap:'KyberSwap', fabric:'Fabric', nordstern:'Nordstern' }; return m[slug] ?? slug; }
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
