/**
 * settlerRegistry.ts — the rotation-proof aggregator address set.
 *
 * 0x Settler's address rotates on every release (feature 2 has rotated 19
 * times). Rather than hardcode addresses, we read them from 0x's own on-chain
 * Deployer/registry — an ERC721 at 0x0000…72ceae (same address on every chain)
 * where tokenId == feature number and the owner is that feature's live Settler.
 * Every rotation is therefore a Transfer, and scanning Transfers yields the
 * complete history.
 *
 * Identity is a SET, not a timeline (Design Decision 2). We only ever ask "is
 * this address 0x?", never "is this the CURRENT Settler?", so an address that
 * was ever a Settler stays identifiable forever. That makes historical trades
 * resolve for free and dissolves 0x's deployment dwell-time problem entirely —
 * no prev() call needed. `fromBlock` is recorded for audit only and is never
 * consulted at lookup.
 */

import { readFile } from 'node:fs/promises';

export interface SettlerEntry {
	aggregator: string;
	feature: number;
	address: string;
	fromBlock: number;
	source: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Extract the 20-byte address from a 32-byte indexed topic. */
function topicToAddress(topic: string): string {
	return ('0x' + topic.slice(26)).toLowerCase();
}

/**
 * Fold ERC721 Transfer logs into the set of every address ever registered to a
 * feature. Burns (transfers to the zero address) retire a feature but do not
 * add an address — the pre-burn owner stays in the set, because it really was a
 * Settler. Feature 1 on Base is exactly this case: minted at 12723120, burned
 * at 14859201.
 */
export function parseDeployerTransfers(
	logs: readonly { topics: readonly string[]; blockNumber: string }[],
	aggregator: string,
): SettlerEntry[] {
	const byAddress = new Map<string, SettlerEntry>();
	for (const l of logs) {
		const to = topicToAddress(l.topics[2]!);
		if (to === ZERO_ADDRESS) continue;
		const feature = Number(BigInt(l.topics[3]!));
		const fromBlock = Number(BigInt(l.blockNumber));
		const prev = byAddress.get(to);
		if (!prev || fromBlock < prev.fromBlock) {
			byAddress.set(to, { aggregator, feature, address: to, fromBlock, source: 'deployer-transfer-scan' });
		}
	}
	return [...byAddress.values()].sort(
		(a, b) => a.feature - b.feature || a.fromBlock - b.fromBlock,
	);
}

export interface SettlersConfig {
	_comment?: string;
	generatedAt?: string;
	deployer: string;
	chainId: number;
	settlers: SettlerEntry[];
}

export interface SettlerRegistry {
	byAddressLower: Map<string, SettlerEntry>;
	all: readonly SettlerEntry[];
}

/**
 * Load and index `configs/settlers.json`. Throws if unreadable — callers that
 * must not fail (the resolver) catch and degrade to an empty registry.
 */
export async function loadSettlerRegistry(path: string): Promise<SettlerRegistry> {
	const raw = await readFile(path, 'utf8');
	const parsed = JSON.parse(raw) as SettlersConfig;
	const byAddressLower = new Map<string, SettlerEntry>();
	for (const s of parsed.settlers ?? []) {
		byAddressLower.set(s.address.toLowerCase(), s);
	}
	return { byAddressLower, all: parsed.settlers ?? [] };
}
