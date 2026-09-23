/**
 * Rate limiting for the paths that cost us money.
 *
 * A single receipt analysis costs ~40 RPC calls (measured), and GET
 * /tx/<chain>/<hash> is that full analysis on every hit — there is no cache
 * and nothing is persisted. It is also public and needs no JS, no CORS
 * preflight, and no password, so it fires just as readily from crawlers and
 * link unfurlers as from a real visitor. An unmetered hit on this route is a
 * direct line to the RPC bill.
 *
 * The store is an interface on purpose. createMemoryStore is correct and free
 * on a single long-lived container (Railway); createRedisStore below is what
 * a serverless deploy (Vercel) needs instead, since each instance there would
 * otherwise keep its own counters and the limit would silently multiply by
 * the instance count. Same interface either way — call sites don't change.
 */

export interface RateLimitStore {
	/** Record one hit and return the running count plus this window's expiry. */
	hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	/** Seconds until the caller may retry. 0 when allowed. */
	retryAfterSecs: number;
	resetAt: number;
}

export interface MemoryStore extends RateLimitStore {
	/** Entries currently tracked. Exposed so the pruning behaviour is testable. */
	size(): number;
}

/**
 * In-memory fixed-window store.
 *
 * Expired entries are swept lazily — at most once per window — rather than on
 * every hit. Without any sweep the map is itself a memory-exhaustion vector: one
 * request per spoofed x-forwarded-for would grow it without bound. Sweeping on
 * every hit would instead make each request O(entries).
 */
export function createMemoryStore(now: () => number = Date.now): MemoryStore {
	const entries = new Map<string, { count: number; resetAt: number }>();
	let lastSweep = now();

	return {
		async hit(key, windowMs) {
			const t = now();
			if (t - lastSweep >= windowMs) {
				for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k);
				lastSweep = t;
			}
			const existing = entries.get(key);
			if (existing && existing.resetAt > t) {
				existing.count += 1;
				return { ...existing };
			}
			const fresh = { count: 1, resetAt: t + windowMs };
			entries.set(key, fresh);
			return { ...fresh };
		},
		size: () => entries.size,
	};
}

/** The subset of an Upstash/Vercel KV client this store needs. */
export interface RedisLikeClient {
	incr(key: string): Promise<number>;
	pexpire(key: string, ms: number): Promise<unknown>;
	pttl(key: string): Promise<number>;
}

/**
 * Fixed-window store backed by Redis (Vercel KV / Upstash).
 *
 * Unlike createMemoryStore, counters live outside the process — the whole
 * point, since a serverless deploy runs many instances and an in-process Map
 * would give each one its own budget. `pexpire` is set only on the first hit
 * (INCR returning 1) so the window's start doesn't drift on every request;
 * `pttl` reads the remaining time back to compute `resetAt` without this
 * process needing to remember when the window began.
 *
 * `keyPrefix` matters here in a way it never did for createMemoryStore: each
 * call to that one got its own private Map, so two limiters could use the same
 * client IP as a key with no collision. A real Redis is one flat keyspace
 * shared by every limiter that points at it, so callers that key by client IP
 * (diagnosis and analysis both do) MUST pass distinct prefixes or their counts
 * will corrupt each other.
 */
export function createRedisStore(
	client: RedisLikeClient,
	options: { now?: () => number; keyPrefix?: string } = {},
): RateLimitStore {
	const now = options.now ?? Date.now;
	const prefix = options.keyPrefix ?? '';
	return {
		async hit(key, windowMs) {
			const redisKey = `${prefix}${key}`;
			const count = await client.incr(redisKey);
			if (count === 1) {
				await client.pexpire(redisKey, windowMs);
			}
			const ttl = await client.pttl(redisKey);
			const resetAt = now() + (ttl > 0 ? ttl : windowMs);
			return { count, resetAt };
		},
	};
}

export function createRateLimiter(
	store: RateLimitStore,
	opts: { limit: number; windowMs: number; now?: () => number },
): (key: string) => Promise<RateLimitResult> {
	const now = opts.now ?? Date.now;
	return async (key: string) => {
		const { count, resetAt } = await store.hit(key, opts.windowMs);
		const allowed = count <= opts.limit;
		return {
			allowed,
			remaining: Math.max(0, opts.limit - count),
			retryAfterSecs: allowed ? 0 : Math.max(0, Math.ceil((resetAt - now()) / 1000)),
			resetAt,
		};
	};
}

/**
 * Identify the caller for rate-limiting purposes.
 *
 * Only the FIRST hop of x-forwarded-for is used: a client can append whatever
 * it likes to that header, but the leftmost entry is what our proxy observed.
 * A missing header yields a dedicated 'unknown' bucket rather than an empty
 * string, so unattributable traffic is limited together instead of every such
 * request looking like a brand-new client.
 */
export function clientKeyFromHeaders(headers: Headers): string {
	const forwarded = headers.get('x-forwarded-for');
	const first = forwarded?.split(',')[0]?.trim();
	if (first) return first;
	const real = headers.get('x-real-ip')?.trim();
	if (real) return real;
	return 'unknown';
}
