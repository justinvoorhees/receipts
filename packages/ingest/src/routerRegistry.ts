import { readFile } from 'node:fs/promises';

export interface RouterEntry {
	name: string;
	address: `0x${string}`;
	version: string;
	fee_recipients: `0x${string}`[];
	detection: 'to_address' | 'solver_eoa';
	active: boolean;
}

export interface RouterRegistry {
	byAddressLower: Map<string, RouterEntry>;
	all: readonly RouterEntry[];
}

/**
 * Load and index the router registry from `configs/routers.json`. The byAddressLower
 * map drives the to-address match in the ingest poller; entries flagged
 * `detection: 'solver_eoa'` need a different path (not implemented in MVP).
 */
export async function loadRouterRegistry(path: string): Promise<RouterRegistry> {
	const raw = await readFile(path, 'utf8');
	const parsed = JSON.parse(raw) as { routers: RouterEntry[] };
	const active = parsed.routers.filter((r) => r.active);
	const byAddressLower = new Map<string, RouterEntry>();
	for (const r of active) {
		byAddressLower.set(r.address.toLowerCase(), r);
	}
	return { byAddressLower, all: active };
}
