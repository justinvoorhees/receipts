import type { Finality } from './schema.js';

/**
 * finality.ts — the admission rule for the permanent Seed layer.
 *
 * An immutable archive of blocks that might be reorged away is a contradiction,
 * so a block may enter `data/seeds/` only once the chain has permanently
 * committed to it. The bar is the OP Stack's own `finalized` tag — an
 * L1-derived guarantee — rather than a chosen confirmation count.
 *
 * Measured on Base 2026-09-03: `finalized` trailed `latest` by ~570 blocks
 * (~19 minutes). Any range anchored to the chain head is therefore entirely
 * unfinalized, which is exactly the mistake this gate exists to refuse.
 */

/**
 * Minimal shape `rpcCall` needs from a fetch response, so a test double doesn't
 * have to construct a real `Response`. The global `fetch` satisfies this
 * structurally.
 */
export interface RpcResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}

/** The test seam: a fake `fetchFn`/`delayFn` pair lets retry+backoff run instantly, with no network. */
export interface RpcCallDeps {
	fetchFn: (url: string, init: RequestInit) => Promise<RpcResponseLike>;
	delayFn: (ms: number) => Promise<void>;
}

const defaultDeps: RpcCallDeps = {
	fetchFn: (url, init) => fetch(url, init),
	delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Total attempts, including the first — 1 initial try plus up to 3 retries. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 250;
/** Clamp for both computed backoff and a server-supplied `Retry-After`, so neither can hang the run. */
const MAX_DELAY_MS = 8_000;

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Exponential backoff with full jitter: the delay is drawn uniformly from
 * `[0, cap]` rather than always equal to `cap`, so callers that all started
 * retrying at once — up to 3N of them, see `fetchBlockPayloads` — don't
 * resynchronize into the very burst that triggered the 429s.
 */
function backoffMs(attempt: number): number {
	const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
	return Math.random() * cap;
}

/** Parse a `Retry-After` header (delay-seconds or an HTTP-date) and clamp it to `MAX_DELAY_MS`. */
function retryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_DELAY_MS));
	const at = Date.parse(header);
	if (Number.isNaN(at)) return null;
	return Math.max(0, Math.min(at - Date.now(), MAX_DELAY_MS));
}

export async function rpcCall<T>(
	rpcUrl: string,
	method: string,
	params: unknown[],
	deps: RpcCallDeps = defaultDeps,
): Promise<T> {
	const { fetchFn, delayFn } = deps;
	let response!: RpcResponseLike;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			response = await fetchFn(rpcUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			});
		} catch {
			// The URL carries an API key. A malformed URL (e.g. a missing scheme)
			// makes fetch() reject at parse time with a message that echoes the
			// whole input string back — so the original error must never surface,
			// whether as this message or as a `cause`. Not retried: a rejection
			// with no response carries no status to make a retry decision on.
			throw new Error(`RPC ${method} failed: network error`);
		}
		if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) break;
		// Only 429/5xx reach here, only when attempts remain: back off and retry.
		// A server-supplied Retry-After wins over the computed backoff.
		const delayMs = retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt);
		await delayFn(delayMs);
	}
	if (!response.ok) {
		// The URL carries an API key, so it must never reach an error message —
		// including after every retry attempt is spent.
		throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
	}
	let body: { result?: T; error?: { code?: unknown; message?: string } };
	try {
		body = (await response.json()) as typeof body;
	} catch {
		// `json()` comes through this package's own `RpcResponseLike` seam, so
		// the rejection is whatever the injected implementation throws — and
		// undici's own parse error already ends with " at <the request URL>",
		// which is where the API key lives. Never let that reach the caller,
		// as this message or as a `cause`.
		throw new Error(`RPC ${method} failed: response body was not valid JSON`);
	}
	if (body.error) {
		// A JSON-RPC error message is PROVIDER-CONTROLLED text. Providers echo
		// the request URL back on auth and quota errors, which would put the
		// API key on stderr and into every CI log, so no part of it is
		// interpolated. The numeric `code` is a JSON-RPC-defined scalar and
		// carries no provider text, so it is the one detail worth keeping.
		const code = typeof body.error.code === 'number' ? body.error.code : 'unknown';
		throw new Error(`RPC ${method} failed: JSON-RPC error code ${code}`);
	}
	if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
	return body.result;
}

/** The highest block the chain has permanently committed to. */
export async function finalizedHead(rpcUrl: string): Promise<number> {
	const block = await rpcCall<{ number: string } | null>(rpcUrl, 'eth_getBlockByNumber', [
		'finalized',
		false,
	]);
	if (!block) throw new Error('Chain reported no finalized block');
	return Number.parseInt(block.number, 16);
}

/**
 * Decide whether a range may be written, and how it must be labelled.
 * Throws unless the range is finalized or the caller has explicitly opted out.
 */
export function classifyRange(
	toBlock: number,
	head: number,
	allowUnfinalized: boolean,
): Finality {
	if (toBlock <= head) return 'finalized';
	const overshoot = toBlock - head;
	if (!allowUnfinalized) {
		throw new Error(
			`Range ends at block ${toBlock}, which is ${overshoot} block(s) past the finalized ` +
				`head (${head}). A Seed file in the permanent archive must contain only finalized ` +
				`blocks. Move the range back, or pass --allow-unfinalized to write it into ` +
				`seeds/provisional/ instead.`,
		);
	}
	return 'unsafe';
}
