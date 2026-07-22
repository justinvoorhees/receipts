/**
 * makerRegistry.ts — curated RFQ market-maker addresses.
 *
 * Unlike settlerRegistry/routerRegistry, makers are NOT scan-discoverable: each
 * entry in configs/makers.json is a human attestation with provenance. This
 * registry is consulted only as a last-resort tier in decomposeRoute Step 4b, for
 * `unknown` legs that neither on-chain RFQ tier proves.
 *
 * `isCuratedMaker` is synchronous (the Step-4b loop calls it inline), so the config
 * is loaded once at module init and cached as a lowercased address Set. A
 * missing/malformed file degrades to an empty set — fail-closed, never throws.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MakerEntry {
	address: string;
	label: string;
	provenance: string;
	addedBy?: string;
	date?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAKERS_CONFIG_PATH = path.resolve(__dirname, '../../../configs/makers.json');

let curatedMakers: Set<string>;
try {
	const raw = await readFile(MAKERS_CONFIG_PATH, 'utf8');
	const parsed = JSON.parse(raw) as { makers?: MakerEntry[] };
	curatedMakers = new Set((parsed.makers ?? []).map((m) => m.address.toLowerCase()));
} catch {
	// Config unreadable (path moved, running outside the checkout) → no curated
	// makers rather than throwing. isCuratedMaker must never throw.
	curatedMakers = new Set();
}

/** True when `address` is a curated (human-attested) RFQ market maker. */
export function isCuratedMaker(address: string): boolean {
	return curatedMakers.has(address.toLowerCase());
}
