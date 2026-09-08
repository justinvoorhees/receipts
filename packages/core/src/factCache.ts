/**
 * factCache.ts — facts about the chain that cannot change, cached across decodes.
 *
 * ⚠️ Read rpcMemo.ts's header before touching this file. The two caches look
 * similar and are opposites:
 *
 *   rpcMemo   per-decode, dies with the request, may hold ANY read.
 *   FactCache process-global, survives runs, may hold ONLY immutable facts.
 *
 * The whole safety argument is that nothing mutable gets in.
 *
 * ⚠️ EVERY KEY IS SCOPED BY chainId. Pool and token addresses are NOT unique
 * across chains, so a process-global cache without this would serve one
 * chain's answer for another's address — silently, and permanently once
 * persisted. The composite key is `${chainId}:${address.toLowerCase()}`.
 *
 * Three rules:
 *
 * 1. `getPool` is NOT here, deliberately. It is a factory lookup at the `latest`
 *    tag whose answer changes when a new fee tier is deployed — the exact thing
 *    rpcMemo's warning forbids pinning. There is no setter for it, and adding
 *    one is the single change that would make this cache unsafe.
 *
 * 2. A NULL IS NEVER A FACT. A failed read and a nonexistent pool are
 *    indistinguishable at every reader in this codebase (`catch → null`), and
 *    that ambiguity has already corrupted receipts once. Only positive results
 *    are stored, so a transport blip costs a re-read, never a wrong answer.
 *
 * 3. A dynamic fee is not a fact — see cachedReaders.ts for the venue allowlist.
 *
 * Keys are lowercased on the way in and out, because callers get addresses from
 * a mix of RPC responses, config files and trace payloads.
 *
 * ⚠️ THE TOKEN FAMILY IS DEFINED HERE BUT DELIBERATELY NOT WIRED TO A READER IN
 * THIS PLAN, and that is not an oversight to "fix" by adding a decimals-only
 * decorator. `TokenFact` carries decimals AND symbol, which two different
 * readers resolve (`decimalsReader`, and `resolveLegSymbols`'s `readSymbol`). A
 * decorator that wrote `{ decimals, symbol: null }` from the decimals path
 * would make a later symbol lookup a cache HIT on a symbol nobody ever read —
 * turning "unknown" into "this token has no symbol", permanently and across
 * runs. The family is populated in v0.2b-2, where both readers are touched
 * together and a complete TokenFact can be written at once.
 */

/** Which singleton protocol produced this pool key. v4 and Infinity share one keyspace. */
export type PoolProtocol = 'v4' | 'infinity';

/** A v4/Infinity poolId's two currencies. Fixed at Initialize, forever. */
export interface PoolKeyFact {
	currency0: string;
	currency1: string;
	protocol: PoolProtocol;
}

/** ERC-20 metadata, set at deploy. `symbol: null` means the token has none we could read. */
export interface TokenFact {
	decimals: number;
	symbol: string | null;
}

/**
 * Immutable pool metadata, learned piecemeal by different readers — hence every
 * field optional and `setPool` merging rather than replacing.
 */
export interface PoolFact {
	token0?: string;
	token1?: string;
	/** ONLY ever set for a static-tier venue. See cachedReaders.ts. */
	feeBps?: number;
	factory?: string;
}

export interface FactCacheEntries {
	poolKeys: [number, string, PoolKeyFact][];
	tokens: [number, string, TokenFact][];
	pools: [number, string, PoolFact][];
}

export interface FactCache {
	getPoolKey(chainId: number, poolId: string): PoolKeyFact | undefined;
	setPoolKey(chainId: number, poolId: string, fact: PoolKeyFact): void;
	getToken(chainId: number, address: string): TokenFact | undefined;
	setToken(chainId: number, address: string, fact: TokenFact): void;
	getPool(chainId: number, address: string): PoolFact | undefined;
	/** Merges into any existing record for this address. */
	setPool(chainId: number, address: string, fact: PoolFact): void;
	/** Everything held, for persistence. Keys are lowercased. */
	entries(): FactCacheEntries;
}

/** Splits a composite `${chainId}:${address}` key back into its parts. */
function splitCompositeKey(key: string): [number, string] {
	const i = key.indexOf(':');
	const chainId = Number(key.slice(0, i));
	const address = key.slice(i + 1);
	return [chainId, address];
}

function compositeKey(chainId: number, address: string): string {
	return `${chainId}:${address.toLowerCase()}`;
}

export function createMemoryFactCache(seed?: Partial<FactCacheEntries>): FactCache {
	const poolKeys = new Map<string, PoolKeyFact>(
		seed?.poolKeys?.map(([chainId, k, v]) => [compositeKey(chainId, k), v]),
	);
	const tokens = new Map<string, TokenFact>(seed?.tokens?.map(([chainId, k, v]) => [compositeKey(chainId, k), v]));
	const pools = new Map<string, PoolFact>(seed?.pools?.map(([chainId, k, v]) => [compositeKey(chainId, k), v]));

	return {
		getPoolKey: (chainId, poolId) => poolKeys.get(compositeKey(chainId, poolId)),
		setPoolKey: (chainId, poolId, fact) => void poolKeys.set(compositeKey(chainId, poolId), fact),
		getToken: (chainId, address) => tokens.get(compositeKey(chainId, address)),
		setToken: (chainId, address, fact) => void tokens.set(compositeKey(chainId, address), fact),
		getPool: (chainId, address) => pools.get(compositeKey(chainId, address)),
		setPool: (chainId, address, fact) => {
			const key = compositeKey(chainId, address);
			pools.set(key, { ...pools.get(key), ...fact });
		},
		entries: () => ({
			poolKeys: [...poolKeys.entries()].map(([k, v]): [number, string, PoolKeyFact] => {
				const [chainId, address] = splitCompositeKey(k);
				return [chainId, address, v];
			}),
			tokens: [...tokens.entries()].map(([k, v]): [number, string, TokenFact] => {
				const [chainId, address] = splitCompositeKey(k);
				return [chainId, address, v];
			}),
			pools: [...pools.entries()].map(([k, v]): [number, string, PoolFact] => {
				const [chainId, address] = splitCompositeKey(k);
				return [chainId, address, v];
			}),
		}),
	};
}
