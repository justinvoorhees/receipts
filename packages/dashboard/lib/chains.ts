/**
 * The chains this app can address.
 *
 * Exactly one entry today, and two things depend on that being true — see the
 * tripwire test in chains.test.ts, which fails the moment CHAINS grows and
 * names both debts that come due at that point.
 *
 * Kept free of imports on purpose: 'use client' components import this module,
 * so it must never reach for next/headers or a node builtin.
 */
export interface Chain {
	readonly id: number;
	readonly slug: string;
	readonly name: string;
	readonly explorer: string;
}

export const CHAINS: readonly Chain[] = [
	{ id: 8453, slug: 'base', name: 'Base', explorer: 'https://basescan.org' },
];

export const DEFAULT_CHAIN: Chain = CHAINS[0]!;

export function chainById(id: number): Chain | null {
	return CHAINS.find((c) => c.id === id) ?? null;
}

/**
 * Resolves a URL chain segment, accepting the canonical slug ('base') or the
 * numeric id ('8453').
 *
 * `canonical` is false for anything the caller should redirect away from — the
 * numeric alias, or a slug in the wrong case. Returning the chain alongside
 * that flag is what lets the caller correct chain and hash in ONE redirect
 * rather than bouncing the browser twice.
 */
export function resolveChainParam(param: string): { chain: Chain; canonical: boolean } | null {
	const bySlug = CHAINS.find((c) => c.slug === param.toLowerCase());
	if (bySlug) return { chain: bySlug, canonical: param === bySlug.slug };

	// Decimal only: a hex id would be a second spelling of the same value, and
	// one canonical spelling per chain is what keeps the redirect in
	// resolveReceiptUrl single-hop.
	if (/^\d+$/.test(param)) {
		const byId = chainById(Number(param));
		if (byId) return { chain: byId, canonical: false };
	}
	return null;
}

export function explorerTx(chain: Chain, hash: string): string {
	return `${chain.explorer}/tx/${hash}`;
}

export function explorerAddress(chain: Chain, address: string): string {
	return `${chain.explorer}/address/${address}`;
}
