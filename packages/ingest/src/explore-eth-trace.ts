import { readFileSync } from 'fs';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

/**
 * Exploration: for each ETH-settled trade, fetch the call trace and compute the
 * trader's EXACT net native-ETH delta (Σ value in − Σ value out across all calls),
 * then compare the implied price to the wrap-net proxy and the market mid. Tells us
 * whether native-delta is the right exact replacement for the proxy.
 */

interface TraceNode { from?: string; to?: string; value?: string; calls?: TraceNode[]; }

function nativeEthDeltas(trace: TraceNode): Map<string, bigint> {
	const d = new Map<string, bigint>();
	const add = (a: string | undefined, v: bigint) => { if (!a) return; const k = a.toLowerCase(); d.set(k, (d.get(k) ?? 0n) + v); };
	const visit = (n: TraceNode) => {
		if (n.value && n.value !== '0x' && n.value !== '0x0') {
			const v = BigInt(n.value);
			if (v > 0n) { add(n.from, -v); add(n.to, v); }
		}
		if (n.calls) for (const c of n.calls) visit(c);
	};
	visit(trace);
	return d;
}

(async () => {
	const rpcUrl = process.env.TCA_RPC_URL!;
	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const lines = readFileSync('/tmp/router_trades.csv', 'utf8').trim().split(/\r?\n/);
	const h = lines[0]!.split(',');
	const ix = (k: string) => h.indexOf(k);
	const eth = lines.slice(1).map((l) => l.split(',')).filter((c) => c[ix('settledIn')] === 'ETH');

	console.log(`Testing ${eth.length} ETH trades — native-delta vs wrap-net vs mid\n`);
	let nativeWins = 0, proxyWins = 0, nativeSane = 0;
	console.log(`${'agg'.padEnd(10)}${'dir'.padEnd(10)}${'usdc'.padStart(9)} ${'ethΔ'.padStart(9)} ${'pNative'.padStart(9)} ${'pProxy'.padStart(9)} ${'mid'.padStart(8)} ${'native bps'.padStart(11)} ${'proxy bps'.padStart(10)}`);
	for (const c of eth) {
		const txHash = c[ix('txHash')] as `0x${string}`;
		const trader = c[ix('trader')]!.toLowerCase();
		const dir = c[ix('direction')]!;
		const usdc = Number(c[ix('usdcAmount')]);
		const mid = Number(c[ix('marketMid')]);
		const pProxy = Number(c[ix('realizedPrice')]);
		try {
			const trace = await (client.request as unknown as (r: { method: string; params: unknown[] }) => Promise<TraceNode>)({
				method: 'debug_traceTransaction',
				params: [txHash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } }],
			});
			const d = nativeEthDeltas(trace);
			const ethDelta = Number(d.get(trader) ?? 0n) / 1e18;
			const pNative = ethDelta !== 0 ? usdc / Math.abs(ethDelta) : NaN;
			const devN = dir === 'sell_weth' ? (mid - pNative) / mid * 1e4 : (pNative - mid) / mid * 1e4;
			const devP = dir === 'sell_weth' ? (mid - pProxy) / mid * 1e4 : (pProxy - mid) / mid * 1e4;
			if (Number.isFinite(devN) && Math.abs(devN) <= 100) nativeSane++;
			if (Number.isFinite(devN) && Math.abs(devN) < Math.abs(devP)) nativeWins++; else proxyWins++;
			console.log(`${c[ix('aggregator')]!.padEnd(10)}${dir.padEnd(10)}${usdc.toFixed(0).padStart(9)} ${ethDelta.toFixed(5).padStart(9)} ${(Number.isFinite(pNative)?pNative.toFixed(2):'NaN').padStart(9)} ${pProxy.toFixed(2).padStart(9)} ${mid.toFixed(2).padStart(8)} ${(Number.isFinite(devN)?devN.toFixed(1):'NaN').padStart(11)} ${devP.toFixed(1).padStart(10)}`);
		} catch (e) {
			console.log(`${c[ix('aggregator')]!.padEnd(10)}${dir.padEnd(10)} TRACE ERROR`);
		}
	}
	console.log(`\nnative within ±100bps of mid: ${nativeSane}/${eth.length}  |  native closer than proxy: ${nativeWins}, proxy closer: ${proxyWins}`);
	process.exit(0);
})();
