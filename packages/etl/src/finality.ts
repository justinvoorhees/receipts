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

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
	const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!response.ok) {
		// The URL carries an API key, so it must never reach an error message.
		throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
	}
	const body = (await response.json()) as { result?: T; error?: { message?: string } };
	if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message ?? 'unknown error'}`);
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
