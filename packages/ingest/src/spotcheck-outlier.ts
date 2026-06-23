import { createPublicClient, http, decodeEventLog, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { extractTradeEndpoints } from './tradeEndpoints.js';
import { getReferencePrice } from './referencePrice.js';
import { signedDeviationBps } from './priceMath.js';

const TX = '0xe73070c37d895d7d871b6427ea0cb12dfb6f142db658c26a9e030799d9c4794b' as `0x${string}`;
const POOL_5BPS = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const short = (a: string) => a.slice(0, 8) + '…' + a.slice(-4);

(async () => {
	const rpcUrl = process.env.TCA_RPC_URL!;
	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	const result = await extractTradeEndpoints({ rpcUrl, txHash: TX });
	const receipt = await client.getTransactionReceipt({ hash: TX });
	const trader = result.trader?.toLowerCase();

	console.log('=== EXTRACTOR RESULT ===');
	console.log('kept:', result.kept, '| direction:', result.direction);
	console.log('trader:', result.trader);
	console.log('USDC raw:', result.usdcAmountRaw?.toString(), '=>', Number(result.usdcAmountRaw) / 1e6, 'USDC');
	console.log('WETH raw:', result.wethAmountRaw?.toString(), '=>', Number(result.wethAmountRaw) / 1e18, 'WETH');
	console.log('realizedPrice:', result.realizedPrice?.toFixed(2), 'USDC/WETH');
	console.log('transferCount:', result.transferCount, '| uniqueAddresses:', result.uniqueAddresses);
	console.log('block:', receipt.blockNumber.toString());

	// All USDC/WETH transfers touching the trader (verify the net by hand)
	console.log('\n=== USDC/WETH transfers touching trader ' + (trader ? short(trader) : '?') + ' ===');
	const usdcWethPoolLegs: { pool: string; usdc: number; weth: number }[] = [];
	let usdcIn = 0, usdcOut = 0, wethIn = 0, wethOut = 0;
	for (const log of receipt.logs) {
		if (log.topics[0] !== TRANSFER_TOPIC) continue;
		const tok = log.address.toLowerCase();
		if (tok !== USDC && tok !== WETH) continue;
		let d;
		try { d = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics }); } catch { continue; }
		const from = (d.args.from as string).toLowerCase();
		const to = (d.args.to as string).toLowerCase();
		if (from !== trader && to !== trader) continue;
		const sym = tok === USDC ? 'USDC' : 'WETH';
		const val = tok === USDC ? Number(d.args.value) / 1e6 : Number(d.args.value) / 1e18;
		const dir = from === trader ? 'OUT' : 'IN ';
		console.log(`  ${dir} ${sym} ${val.toFixed(sym === 'USDC' ? 2 : 6).padStart(14)}  ${short(from)} → ${short(to)}`);
		if (sym === 'USDC') { if (from === trader) usdcOut += val; else usdcIn += val; }
		else { if (from === trader) wethOut += val; else wethIn += val; }
	}
	console.log(`  NET: USDC ${(usdcIn - usdcOut).toFixed(2)}  WETH ${(wethIn - wethOut).toFixed(6)}`);

	// Market reference + all-in cost
	const marketMid = await getReferencePrice({ rpcUrl, poolAddress: POOL_5BPS, blockNumber: receipt.blockNumber });
	const allIn = signedDeviationBps(result.direction!, marketMid, result.realizedPrice!);
	console.log('\n=== ALL-IN COST ===');
	console.log('marketMid (5bps slot0 @ N-1):', marketMid.toFixed(2), 'USDC/WETH');
	console.log('realizedPrice               :', result.realizedPrice!.toFixed(2), 'USDC/WETH');
	console.log('allInCostBps                :', allIn.toFixed(2), 'bps');
	console.log('\n(positive = user paid above market mid; for a large buy this is impact + fees)');

	process.exit(0);
})();
