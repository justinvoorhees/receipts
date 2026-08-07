/**
 * contractNames — resolve a contract address to its verified Basescan
 * ContractName via the FREE Etherscan V2 getsourcecode API (chainid 8453).
 *
 * NEVER called inside analyzeTransaction/decomposeRoute (core analysis stays
 * RPC-pure). Invoked only from the dashboard's enrichment step (loadReceipt,
 * on the /tx render path). Fails closed: no key / network / parse error → null.
 *
 * A committed JSON cache (configs/contractNames.json) seeds an in-process
 * cache and is written through best-effort so repeated addresses are not
 * refetched across runs. `MANUAL_OVERRIDES` is the last-resort curated map —
 * starts empty; add an entry only when the free API can't produce an
 * acceptable name.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './atomicWrite.js';
import type { FeeSinkOut } from './decomposeRoute.js';

export interface FeeSinkNamed {
	address: string;
	feeBps: number;
	source: string;
	name: string | null;
}

export interface NameResolverDeps {
	fetchImpl?: typeof fetch;
	apiKey?: string | undefined;
	/** address(lowercased) → name-or-null. When provided, disk cache is bypassed. */
	cache?: Record<string, string | null>;
}

// Curated last resort, keyed by lowercased address. Add an entry ONLY for a name
// Basescan displays but `getsourcecode` cannot return — i.e. a name TAG on an
// unverified contract, which is Pro-API-only. Never add a name you inferred.
// Checked ahead of the disk cache below, so an entry survives the cache being
// rewritten with the API's `null`.
//
// Deliberately NOT listed here: the payout adapter
// 0x9a972d8c3a8dd27e5811cbcb75ebdac924fb53a1. It is unverified, it is redeployed
// every few weeks by the same EOA, and its Basescan internal txns are dominated
// by Mayan — which makes "Mayan" the tempting and WRONG label, since Mayan is
// only the payout `recipient`. It renders as a truncated address on purpose.
// Investigation: docs/positive-slippage-capture.md.
const MANUAL_OVERRIDES: Record<string, string> = {
	// Basescan name tag "Relay: Solver". Unverified contract, so the free
	// getsourcecode API returns no ContractName and the cache holds null.
	// It is also the corpus's only `vault_map` fee sink — a registry hit, not a
	// guess. Seen in docs/qa/corpus.json's frozen id 328.
	'0xf70da97812cb96acdf810712aa562db8dfa3dbef': 'Relay: Solver',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.resolve(__dirname, '../../../configs/contractNames.json');

// Process-lifetime cache, seeded from the committed JSON (fail → empty).
const processCache: Record<string, string | null> = loadCacheSeed();

function loadCacheSeed(): Record<string, string | null> {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, string | null>;
	} catch {
		return {};
	}
}

/**
 * Best-effort write-through of the process cache. Never throws.
 *
 * Atomic because this fires on a user-triggered request path: a plain
 * writeFileSync lets two concurrent resolutions interleave and corrupt the
 * file. A failed write is fine — this is a best-effort, per-instance cache
 * with no durable store behind it; a read-only FS (e.g. serverless) just
 * means every request re-resolves names for the process's lifetime instead
 * of persisting them.
 */
function persistCache(): void {
	atomicWriteJson(CACHE_PATH, processCache);
}

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = 8453;
// Node's fetch has no default timeout. This call now runs on the /tx render
// path (via enrichFeeSinkNames), one sequential await per fee sink — a hung
// socket would otherwise hang the product page render indefinitely.
const TIMEOUT_MS = 3_000;

export async function resolveContractName(address: string, deps: NameResolverDeps = {}): Promise<string | null> {
	const key = address.toLowerCase();
	const override = MANUAL_OVERRIDES[key];
	if (override) return override;

	const injected = deps.cache;
	const cache = injected ?? processCache;
	if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key] ?? null;

	// `in`, not `??`: an explicit `apiKey: undefined` means "no key", and must not
	// silently fall through to the environment — that would make the injection
	// seam leak ambient state and the no-key tests env-dependent.
	const apiKey = 'apiKey' in deps ? deps.apiKey : process.env.ETHERSCAN_API_KEY;
	const fetchImpl = deps.fetchImpl ?? fetch;
	if (!apiKey) return null;

	try {
		const url = `${ETHERSCAN_V2}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${key}&apikey=${apiKey}`;
		const resp = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!resp.ok) {
			cache[key] = null;
			if (!injected) persistCache();
			return null;
		}
		const json = (await resp.json()) as { result?: Array<{ ContractName?: string }> };
		const raw = json?.result?.[0]?.ContractName ?? '';
		const name = raw.trim() === '' ? null : raw.trim();
		cache[key] = name;
		if (!injected) persistCache();
		return name;
	} catch {
		return null; // fail closed; do NOT poison the cache on transient errors
	}
}

export async function enrichFeeSinkNames(sinks: FeeSinkOut[], deps: NameResolverDeps = {}): Promise<FeeSinkNamed[]> {
	const out: FeeSinkNamed[] = [];
	for (const s of sinks) {
		const name = await resolveContractName(s.address, deps);
		out.push({ address: s.address, feeBps: s.feeBps, source: s.source, name });
	}
	return out;
}
