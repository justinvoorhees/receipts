import { createPublicClient, http, decodeEventLog, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

/**
 * Orientation script (read-only). For each sample tx, dump every ERC-20
 * Transfer in *event-log order* so we can confirm the founding engineer's
 * model: input = first transfer, output = last(ish) transfer, with fee/
 * integrator diversions in between. No DB writes, no decode pipeline.
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const KNOWN: Record<string, { sym: string; dp: number }> = {
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { sym: 'USDC', dp: 6 },
	'0x4200000000000000000000000000000000000006': { sym: 'WETH', dp: 18 },
};
const LABEL: Record<string, string> = {
	'0xd0b53d9277642d899df5c87a3966a349a798f224': 'POOL(5bps)',
	'0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW-Settlement',
	'0x0000000071727de22e5e9d8baf0edac6f37da032': '4337-EntryPoint',
};

const SAMPLES: Array<{ hash: `0x${string}`; note: string }> = [
	{ hash: '0x007a5e1233a1bce6bd41fc572619543c7503dc04b796d58bd9733f68ffcc2a3a', note: 'KyberSwap sell $23.9k (single-hop, gate-clean)' },
	{ hash: '0x5064017d39b4864d04c6cd92652444a262b5b0cca6622145eb816ce6029c51c8', note: '1inch buy $11.8k (single-hop, gate NO_TRADER)' },
	{ hash: '0xb4dee6d46bd9de6b2a78212e725c88ce8d9de76f853c9e2506da9909e9714fa8', note: '1inch buy $28.8k (4337 EntryPoint as tx.to)' },
	{ hash: '0xa5835f381792e3e561697247c63f0b6a1a5f4a6be546fdcc389814d45ec196b5', note: 'Velora buy $62.3k (multi-hop)' },
	{ hash: '0xbcaa790ee099f6f327a33438fec1020c84485733b04d2a5be421be66ca62671f', note: 'Relay buy $16.1k' },
];

const short = (a: string) => {
	const l = a.toLowerCase();
	if (LABEL[l]) return LABEL[l];
	return a.slice(0, 8) + '…' + a.slice(-4);
};

(async () => {
	const client = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
	for (const { hash, note } of SAMPLES) {
		const [receipt, tx] = await Promise.all([
			client.getTransactionReceipt({ hash }),
			client.getTransaction({ hash }),
		]);
		console.log(`\n${'='.repeat(90)}`);
		console.log(`${note}`);
		console.log(`tx.from=${short(tx.from)}  tx.to=${tx.to ? short(tx.to) : 'null'}  block=${receipt.blockNumber}`);
		console.log(`${'─'.repeat(90)}`);

		const transfers = receipt.logs
			.filter((l) => l.topics[0] === TRANSFER_TOPIC)
			.map((l) => {
				try {
					const d = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
					return { token: l.address.toLowerCase(), from: d.args.from as string, to: d.args.to as string, value: d.args.value as bigint, logIndex: l.logIndex };
				} catch {
					return null;
				}
			})
			.filter((x): x is NonNullable<typeof x> => x !== null);

		console.log(`${transfers.length} ERC-20 Transfer logs (in event order):`);
		transfers.forEach((t, i) => {
			const k = KNOWN[t.token];
			const sym = k ? k.sym : short(t.token);
			const amt = k ? (Number(t.value) / 10 ** k.dp).toFixed(k.dp === 6 ? 2 : 6) : t.value.toString();
			const tag = i === 0 ? '  ◀── FIRST (input?)' : i === transfers.length - 1 ? '  ◀── LAST (output?)' : '';
			const fromU = t.from.toLowerCase() === tx.from.toLowerCase() ? '*' : ' ';
			const toU = t.to.toLowerCase() === tx.from.toLowerCase() ? '*' : ' ';
			console.log(`  [${String(i).padStart(2)}] ${sym.padEnd(12)} ${amt.padStart(22)}  ${fromU}${short(t.from)} → ${short(t.to)}${toU}${tag}`);
		});
		console.log(`  (* = tx.from / sender EOA)`);
	}
	process.exit(0);
})();
