import { writeFileSync } from 'fs';

/**
 * Stage 1 of router-centric discovery (FREE — Blockscout, no key, no Alchemy CU).
 *
 * For each aggregator router, enumerate every transaction that called it over
 * the 2-week window — both top-level calls (`txlist`, to=router) and calls made
 * via EntryPoint/proxies (`txlistinternal`, to=router). Union the tx hashes,
 * dedupe globally, tag by aggregator, and write candidates to a file for the
 * (CU-spending) extraction stage. Prints per-aggregator + total counts.
 *
 * Blockscout serves a free Etherscan-compatible API for Base (no key). Etherscan
 * v2 free tier does NOT cover Base (chainid 8453) and Routescan doesn't index it.
 * Pagination via startblock cursor; global dedupe absorbs the one-block overlap.
 */

const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api';
const START_BLOCK = Number(process.env.START_BLOCK ?? 46300000);
const END_BLOCK = Number(process.env.END_BLOCK ?? 47525000);
const PAGE_SIZE = 1000; // conservative for Blockscout's Etherscan-compat shim
const RATE_LIMIT_MS = 500;
const OUT_PATH = '/tmp/router_candidates.json';
const MAX_CANDIDATES_PER_ROUTER = Number(process.env.MAX_CANDIDATES_PER_ROUTER ?? 25000);

// "Our aggregators" — every active router in configs/routers.json, grouped by name.
const ROUTERS: Array<{ aggregator: string; address: string }> = [
	{ aggregator: 'Odos', address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1' }, // V2 — deferred: also add Odos V3 0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05 (live on Base) for fuller coverage
	{ aggregator: '0x', address: '0xdef1c0ded9bec7f1a1670819833240f027b25eff' },
	{ aggregator: 'KyberSwap', address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' },
	{ aggregator: '1inch', address: '0x1111111254eeb25477b68fb85ed929f73a960582' }, // v5
	{ aggregator: '1inch', address: '0x111111125421ca6dc452d289314280a0f8842a65' }, // v6
	{ aggregator: 'Velora', address: '0x6a000f20005980200259b80c5102003040001068' }, // v6.2
	{ aggregator: 'Velora', address: '0x59C7C832e96D2568bea6db468C1aAdcbbDa08A52' }, // v5
	{ aggregator: 'Fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da' },
	{ aggregator: 'Nordstern', address: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d' },
	{ aggregator: 'Relay', address: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be' }, // RelayApprovalProxyV3 on Base
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExplorerTx {
	hash?: string;
	transactionHash?: string; // txlistinternal uses this field on Blockscout
	blockNumber: string;
	to: string;
	from: string;
}

async function fetchWithRetry(url: string, retries = 2): Promise<unknown> {
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 90000);
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timeoutId);
			const text = await res.text();
			try {
				return JSON.parse(text);
			} catch {
				console.warn(`    retry ${attempt + 1}/${retries} — got non-JSON (${text.slice(0, 40)}…)`);
				await sleep(2000 * (attempt + 1));
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`    retry ${attempt + 1}/${retries} — fetch error: ${msg}`);
			await sleep(2000 * (attempt + 1));
		}
	}
	console.warn(`    giving up after ${retries} retries — treating as empty result`);
	return { message: 'NOTOK', result: [] };
}

async function fetchAll(
	address: string,
	action: 'txlist' | 'txlistinternal',
): Promise<string[]> {
	const addrLower = address.toLowerCase();
	const hashes: string[] = [];
	let cursor = START_BLOCK;
	for (;;) {
		const url =
			`${BLOCKSCOUT_BASE}?module=account&action=${action}` +
			`&address=${address}&startblock=${cursor}&endblock=${END_BLOCK}` +
			`&page=1&offset=${PAGE_SIZE}&sort=asc`;
		const json = (await fetchWithRetry(url)) as { message?: string; result: unknown };
		await sleep(RATE_LIMIT_MS);

		const batch = json.result;
		if (!Array.isArray(batch)) break;
		if (batch.length === 0) break;

		// Keep only calls whose target is the router (to == router)
		for (const tx of batch as ExplorerTx[]) {
			if (tx.to && tx.to.toLowerCase() === addrLower) {
				const h = tx.hash ?? tx.transactionHash;
				if (h) hashes.push(h);
			}
		}

		if (hashes.length >= MAX_CANDIDATES_PER_ROUTER) {
			console.log(`    ⏸ cap reached (${hashes.length} ≥ ${MAX_CANDIDATES_PER_ROUTER}) — stopping pagination`);
			break;
		}
		if (batch.length < PAGE_SIZE) break; // last page
		const lastBlock = Number((batch[batch.length - 1] as ExplorerTx).blockNumber);
		if (!Number.isFinite(lastBlock) || lastBlock < cursor) break; // safety
		cursor = lastBlock; // one-block overlap is fine — global dedupe handles it
	}
	return hashes;
}

async function main(): Promise<void> {
	console.log(`Router-centric discovery (Blockscout) — blocks ${START_BLOCK}..${END_BLOCK} (~4 weeks)\n`);

	// hash -> aggregator (first writer wins; a hash hitting two routers is rare)
	const hashToAgg = new Map<string, string>();
	const perAgg = new Map<string, { external: number; internal: number; unique: Set<string> }>();

	for (const { aggregator, address } of ROUTERS) {
		const stat = perAgg.get(aggregator) ?? { external: 0, internal: 0, unique: new Set<string>() };
		const ext = await fetchAll(address, 'txlist');
		const int = await fetchAll(address, 'txlistinternal');
		stat.external += ext.length;
		stat.internal += int.length;
		for (const h of [...ext, ...int]) {
			stat.unique.add(h);
			if (!hashToAgg.has(h)) hashToAgg.set(h, aggregator);
		}
		perAgg.set(aggregator, stat);
		console.log(`  ${aggregator.padEnd(10)} ${address}  txlist=${ext.length}  internal=${int.length}`);
	}

	console.log('\n=== PER AGGREGATOR (unique tx hashes calling the router) ===');
	for (const [agg, s] of perAgg) {
		console.log(`  ${agg.padEnd(10)} ${String(s.unique.size).padStart(7)} unique  (ext ${s.external} + int ${s.internal})`);
	}

	const candidates = [...hashToAgg.entries()].map(([hash, aggregator]) => ({ hash, aggregator }));
	writeFileSync(OUT_PATH, JSON.stringify(candidates, null, 0));
	console.log(`\nTotal unique candidate txns: ${candidates.length}`);
	console.log(`Written to ${OUT_PATH}`);
	console.log('\nNext: extraction stage (receipt-based) will spend Alchemy CU on these.');
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
