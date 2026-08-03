/**
 * List CANDIDATE UniswapX reactor addresses from live `Fill` logs on Base.
 *
 * Run:  npm run reactors:refresh   (requires TCA_RPC_URL)
 *
 * ⚠️ This script does NOT write configs/reactors.json and must never be
 * trusted to do so. The Fill topic0 (bytes32,address,address,uint256) is
 * NOT UniswapX-exclusive — other protocols emit an identically-signatured
 * event, so "distinct emitters of the Fill topic" is not itself proof of
 * being a UniswapX reactor. Unlike settlers:refresh (where the analogous
 * on-chain set genuinely is authoritative), this scan only produces
 * CANDIDATES that a human must verify per-entry — e.g. against Uniswap's
 * officially published deployments
 * (https://developers.uniswap.org/contracts/uniswapx/deployments) — before
 * ever landing in configs/reactors.json. That file is hand-curated; treat
 * this script's output as a lead-finding aid only, same "never ingest a
 * page wholesale" rule already applied to aggregator router allowlists.
 */
import { FILL_TOPIC0 } from '../settlementDecoders.js';

const WINDOW_BLOCKS = 2_000_000n; // ~6 weeks on Base; widen if the set looks thin

// QuickNode returns transient errors ("block meta not found for block #N" — the
// block it names is unrelated to the range asked for) while its log index
// settles. A single blip is enough to abort the whole scan, and the 10k chunking
// below means one run now makes ~200 sequential calls rather than 4, so a run is
// far more likely to encounter one. Retry a few times before giving up; a genuine
// error (bad range, missing add-on) still fails after exhausting the attempts.
const RPC_ATTEMPTS = 4;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
	let lastError = '';
	for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const json = (await res.json()) as { result?: unknown; error?: { message: string } };
		if (!json.error) return json.result;
		lastError = json.error.message;
		if (attempt < RPC_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
	}
	throw new Error(`${method} failed after ${RPC_ATTEMPTS} attempts: ${lastError}`);
}

// QuickNode (our RPC provider) enforces a hard 10,000-BLOCK RANGE cap on
// eth_getLogs: a wider window returns HTTP 413 even when only a handful of logs
// match, so this is a range limit, not a response-size limit. Page the scan in
// fixed-size chunks and concatenate; this still derives the candidate set purely
// from live Fill logs, just paginated to respect the provider limit.
//
// Do not raise this above 10_000 without re-probing. (The previous value of
// 500_000 worked only because Alchemy capped on response SIZE instead — under
// that provider a sparse topic like Fill could span far more blocks per call.
// At WINDOW_BLOCKS = 2M this now costs ~200 sequential requests, not 4.)
const CHUNK_BLOCKS = 10_000n;

async function getLogsChunked(
	rpcUrl: string,
	fromBlockNum: bigint,
	toBlockNum: bigint,
): Promise<{ address: string; transactionHash: string }[]> {
	const logs: { address: string; transactionHash: string }[] = [];
	for (let start = fromBlockNum; start <= toBlockNum; start += CHUNK_BLOCKS) {
		const end = start + CHUNK_BLOCKS - 1n > toBlockNum ? toBlockNum : start + CHUNK_BLOCKS - 1n;
		const chunk = (await rpc(rpcUrl, 'eth_getLogs', [
			{ topics: [FILL_TOPIC0], fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) },
		])) as { address: string; transactionHash: string }[];
		logs.push(...chunk);
	}
	return logs;
}

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL is not set — export it or source .env');

	const head = BigInt((await rpc(rpcUrl, 'eth_blockNumber', [])) as string);
	const fromBlockNum = head - WINDOW_BLOCKS;
	const logs = await getLogsChunked(rpcUrl, fromBlockNum, head);

	const byAddress = new Map<string, { count: number; sampleTx: string }>();
	for (const log of logs) {
		const addr = log.address.toLowerCase();
		const existing = byAddress.get(addr);
		if (existing) {
			existing.count += 1;
		} else {
			byAddress.set(addr, { count: 1, sampleTx: log.transactionHash });
		}
	}

	if (byAddress.size === 0) {
		throw new Error('Fill scan produced 0 candidate emitters — widen WINDOW_BLOCKS or check the RPC');
	}

	const rows = [...byAddress.entries()].sort(([a], [b]) => a.localeCompare(b));

	console.log('='.repeat(72));
	console.log('UNVERIFIED CANDIDATES — distinct emitters of the UniswapX Fill topic0');
	console.log(`on Base over the last ${WINDOW_BLOCKS} blocks. The Fill event signature is`);
	console.log('shared by non-UniswapX contracts, so NONE of these are reactors until a');
	console.log('human verifies each one individually (e.g. against Uniswap\'s published');
	console.log('deployments: https://developers.uniswap.org/contracts/uniswapx/deployments).');
	console.log('');
	console.log('The committed configs/reactors.json is HAND-CURATED and is NOT regenerated');
	console.log('by this script. Do not copy this list into it without per-entry verification.');
	console.log('='.repeat(72));
	console.log('');
	for (const [address, { count, sampleTx }] of rows) {
		console.log(`${address}  fillLogs=${count}  sampleTx=${sampleTx}`);
	}
	console.log('');
	console.log(`${rows.length} candidate emitter(s) found.`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
