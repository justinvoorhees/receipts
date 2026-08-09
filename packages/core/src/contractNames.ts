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
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Locate the committed name cache, preferring a runtime search over the
 * build-time module path. Returns null when neither finds a file.
 *
 * The obvious implementation is `path.resolve(dirname(fileURLToPath(
 * import.meta.url)), '../../../configs/...')`, and it carries a hazard worth
 * writing down. Next bundles @fabric-tca/core from source (transpilePackages in
 * next.config.mjs), and webpack replaces `import.meta.url` with a STRING
 * LITERAL of the absolute path on the machine that ran the build — verified by
 * grepping .next/server/chunks after a production build, which contained a
 * literal `file:///Users/<builder>/.../packages/core/src/contractNames.ts`.
 *
 * That is fine on Railway TODAY: with no Dockerfile or railway.json in the
 * repo, Nixpacks builds inside the deployment container, so the baked path is
 * the container's own /app/... and still resolves at runtime. It breaks the
 * moment build and run stop sharing a filesystem — a local build shipped as an
 * artifact, a multi-stage Docker build, CI producing the bundle, or
 * `output: 'standalone'` relocating files. And it breaks SILENTLY, because "no
 * cache file" and "cache file somewhere I cannot see" land in the same catch.
 *
 * So: try process.cwd() first, which has no build-time footprint to bake and
 * covers everywhere this module runs (the Next server, cwd packages/dashboard;
 * vitest, the analysis scripts and tsc-built dist, cwd the repo root — the
 * upward walk spans those depths). Fall back to the module-relative path, which
 * is genuine under plain Node and correct-by-accident under Nixpacks. Neither
 * alone covers every case; together they do.
 *
 * The same import.meta.url pattern still resolves routers.json, settlers.json,
 * makers.json, reactors.json and entrypoints.json in this package. Those are
 * NOT broken today for the reason above, and are deliberately left alone here
 * rather than swept in on a render-path fix — but they share this hazard, and
 * a change to how this app is built is what would surface it in all six at once.
 */
const MODULE_RELATIVE_CACHE_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../configs/contractNames.json',
);

export function resolveCachePath(
	startDir: string = process.cwd(),
	fallback: string | null = MODULE_RELATIVE_CACHE_PATH,
): string | null {
	let dir = path.resolve(startDir);
	// Enough to climb packages/<pkg>/<subdir> and stop well short of '/'.
	for (let up = 0; up < 6; up += 1) {
		const candidate = path.join(dir, 'configs', 'contractNames.json');
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fallback !== null && existsSync(fallback) ? fallback : null;
}

const CACHE_PATH = resolveCachePath();

// Process-lifetime cache, seeded from the committed JSON (fail → empty).
const processCache: Record<string, string | null> = loadCacheSeed();

function loadCacheSeed(): Record<string, string | null> {
	if (CACHE_PATH === null) return {};
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
 *
 * Skipped entirely when no cache file was found: this writes THROUGH to a file
 * that is committed and curated, so it updates one that exists rather than
 * creating one at a guessed location.
 */
function persistCache(): void {
	if (CACHE_PATH === null) return;
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
		// Deliberately NOT cached — same reasoning as the catch below. A non-2xx
		// (429, 502, 403) is a statement about Etherscan, not about the contract,
		// and `cache[key] = null` here would record "no verified name" for it
		// permanently: the write is persisted, and the cache is consulted ahead of
		// every later fetch, so one rate-limited minute costs the name forever.
		if (!resp.ok) return null;
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

/**
 * Concurrent, not sequential: this runs on the /tx render path, and each cache
 * miss is a network round trip capped at TIMEOUT_MS. Awaited one at a time, N
 * cold sinks add up to N x TIMEOUT_MS of latency to a page render that is
 * already ~40 RPC calls deep. The lookups are independent, and a receipt never
 * has more than a handful of sinks, so there is nothing to pace here.
 *
 * Promise.all preserves input order in its result, so the returned array still
 * lines up with `sinks` positionally — which the receipt UI relies on.
 */
export async function enrichFeeSinkNames(sinks: FeeSinkOut[], deps: NameResolverDeps = {}): Promise<FeeSinkNamed[]> {
	return Promise.all(
		sinks.map(async (s) => ({
			address: s.address,
			feeBps: s.feeBps,
			source: s.source,
			name: await resolveContractName(s.address, deps),
		})),
	);
}
