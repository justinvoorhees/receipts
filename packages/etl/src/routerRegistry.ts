import { readFile } from 'node:fs/promises';
import { sqlLiteral } from './writeParquet.js';

/**
 * routerRegistry.ts — load `configs/routers.json` for the Derived layer.
 *
 * ⚠️ The path is a RUNTIME argument. The repo's six other `configs/*.json`
 * consumers bake the build machine's absolute path via `import.meta.url` and
 * work only because Nixpacks builds in-container. Nothing here repeats that.
 *
 * ⚠️ This registry is curated for aggregator IDENTITY, not for population
 * selection. Measured against the pilot Seed, `tx_to` membership catches 665
 * transactions — 4% of the 13,511 that emit a Swap log — and Uniswap's
 * UniversalRouter, the largest named router in that window, is absent from it.
 * Do not "fix" that by widening this file: `resolveAggregator` reads it too,
 * and a router added for population reasons would change aggregator labels.
 */

export interface RouterEntry {
	/** Lowercased. The Seed's `tx_to` is whatever the RPC returned, so joins use `lower(tx_to)`. */
	address: string;
	name: string;
	version: string;
}

interface RawRouter {
	name?: unknown;
	address?: unknown;
	version?: unknown;
	active?: unknown;
}

export async function loadRouterRegistry(configPath: string): Promise<RouterEntry[]> {
	let text: string;
	try {
		text = await readFile(configPath, 'utf8');
	} catch (err) {
		throw new Error(`Cannot read router registry at ${configPath}: ${(err as Error).message}`);
	}

	const parsed = JSON.parse(text) as { routers?: RawRouter[] };
	const raw = Array.isArray(parsed.routers) ? parsed.routers : [];

	const entries: RouterEntry[] = [];
	for (const router of raw) {
		if (router.active !== true) continue;
		if (typeof router.address !== 'string' || typeof router.name !== 'string') {
			throw new Error(`Router registry at ${configPath} has an entry with no address or name`);
		}
		entries.push({
			address: router.address.toLowerCase(),
			name: router.name,
			version: typeof router.version === 'string' ? router.version : '',
		});
	}

	if (entries.length === 0) {
		// An empty filter would silently reclassify every 'both' row as
		// 'swap_log' and drop the 'router' rows entirely — a wrong file, not an
		// empty one, which is far worse.
		throw new Error(`Router registry at ${configPath} has no active routers`);
	}
	return entries;
}

/** Render entries as a SQL VALUES list: `('0xaa','A','V1'),('0xbb','B','V2')`. */
export function routerValuesSql(entries: readonly RouterEntry[]): string {
	if (entries.length === 0) {
		throw new Error('A router VALUES list needs at least one router');
	}
	return entries
		.map((e) => `(${sqlLiteral(e.address)},${sqlLiteral(e.name)},${sqlLiteral(e.version)})`)
		.join(',');
}
