/**
 * Rate limiting for the paths that cost us money.
 *
 * A single receipt analysis costs ~40 RPC calls (measured), so an unmetered
 * POST /api/receipts is a direct line to our RPC bill — and every accepted
 * request also writes a permanent DB row. The GET /tx/<chain>/<hash> path is
 * cheaper per hit (~1 call) but far easier to trigger: it needs no JS, no CORS
 * preflight, and fires from crawlers and link previews.
 *
 * The store is an interface on purpose. We run a single long-lived container
 * today, where an in-memory Map is correct and free. On a serverless host each
 * instance would keep its own counters and the limit would silently multiply by
 * the instance count — swap in a Redis-backed store there WITHOUT touching call
 * sites.
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
