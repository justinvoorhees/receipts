import { decodeTransaction } from './decoder.js';

const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const rpcUrl = process.env.TCA_RPC_URL!;

const TXS: Array<{ hash: `0x${string}`; agg: string }> = [
	{ hash: '0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9', agg: '1inch sell $131k (27bps resid)' },
	{ hash: '0x32db5b72bc7807182772aeef58910b20fbcda3ec68f85d9dcc451050be4efb61', agg: '1inch buy $29k (6.7bps resid)' },
];

(async () => {
	for (const { hash, agg } of TXS) {
		const d = await decodeTransaction({
			rpcUrl,
			txHash: hash,
			context: { aggregator: null, poolAddress: POOL, poolFeeTier: 500 },
		});
		const user = d.from.toLowerCase();
		console.log(`\n=== ${agg} (${d.direction}) ===`);
		console.log(`Pool Swap event: amountIn=${d.amountInRaw} amountOut=${d.amountOutRaw}`);

		const net: Record<string, bigint> = { [USDC]: 0n, [WETH]: 0n };
		for (const t of d.transfers) {
			const tok = t.token.toLowerCase();
			if (t.to.toLowerCase() === user) net[tok] += t.value;
			if (t.from.toLowerCase() === user) net[tok] -= t.value;
		}
		const usdcDelta = Number(net[USDC]) / 1e6;
		const wethDelta = Number(net[WETH]) / 1e18;
		console.log(`User wallet net: USDC ${usdcDelta.toFixed(2)}  WETH ${wethDelta.toFixed(6)}`);

		if (d.direction === 'buy_weth') {
			const poolPrice = Number(d.amountInRaw) / 1e6 / (Number(d.amountOutRaw) / 1e18);
			const userPrice = Math.abs(usdcDelta) / Math.abs(wethDelta);
			const feeBps = ((userPrice - poolPrice) / poolPrice) * 10000;
			console.log(`Pool price: ${poolPrice.toFixed(2)} | User price: ${userPrice.toFixed(2)} | gap=${feeBps.toFixed(2)}bps`);
		} else {
			const poolPrice = Number(d.amountOutRaw) / 1e6 / (Number(d.amountInRaw) / 1e18);
			const userPrice = Math.abs(usdcDelta) / Math.abs(wethDelta);
			const feeBps = ((poolPrice - userPrice) / poolPrice) * 10000;
			console.log(`Pool price: ${poolPrice.toFixed(2)} | User price: ${userPrice.toFixed(2)} | gap=${feeBps.toFixed(2)}bps`);
		}

		console.log('Transfers (non-user, non-pool recipients):');
		for (const t of d.transfers) {
			const toL = t.to.toLowerCase();
			if (toL === user || toL === POOL.toLowerCase()) continue;
			const sym = t.token.toLowerCase() === USDC ? 'USDC' : 'WETH';
			const val = sym === 'USDC' ? Number(t.value) / 1e6 : Number(t.value) / 1e18;
			console.log(`  ${sym} ${val.toFixed(6)} -> ${t.to.slice(0, 10)} (from ${t.from.slice(0, 10)})`);
		}
	}
	process.exit(0);
})();
