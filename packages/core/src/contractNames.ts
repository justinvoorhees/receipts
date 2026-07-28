/**
 * contractNames — resolve a contract address to its verified Basescan
 * ContractName via the FREE Etherscan V2 getsourcecode API (chainid 8453).
 *
 * NEVER called inside analyzeTransaction/decomposeRoute (core analysis stays
 * RPC-pure). Invoked only in the persist path (dashboard API route +
 * repopulation script). Fails closed: no key / network / parse error → null.
 *
 * A committed JSON cache (configs/contractNames.json) seeds an in-process
 * cache and is written through best-effort so repeated addresses are not
 * refetched across runs. `MANUAL_OVERRIDES` is the last-resort curated map —
 * starts empty; add an entry only when the free API can't produce an
 * acceptable name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Curated last resort. Empty by design — see spec. Keyed by lowercased address.
const MANUAL_OVERRIDES: Record<string, string> = {};

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

/** Best-effort write-through of the process cache. Never throws. */
function persistCache(): void {
	try {
		writeFileSync(CACHE_PATH, JSON.stringify(processCache, null, 2) + '\n');
	} catch {
		// Read-only FS (e.g. serverless) → the DB remains the durable store.
	}
}

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = 8453;

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
		const resp = await fetchImpl(url);
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
