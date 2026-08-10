/**
 * routeVenueScan — detect the swap venues a trade touched, from its trace logs.
 *
 * Split out of decomposeRoute.ts (2026-07-21). Pure detection: it classifies
 * pool addresses by swap-event topic and factory, and takes any RPC-backed
 * factory reader as a parameter, so it depends on neither the orchestrator nor
 * the RPC reader factories.
 */
import { parseAbiItem, toEventSelector, decodeEventLog } from 'viem';
import type { VenueType } from './routeGraph.js';
import type { LogLike } from './tradeEndpoints.js';
import { classifyKnownVenueAddress, classifyV3Factory } from './venueClassification.js';
import { INFINITY_SWAP_TOPIC, collectInfinitySwaps } from './infinityLegs.js';
import { PANCAKE_INFINITY_VAULT } from './tradeDecoders.js';

// ─── Constants ───

const PANCAKE_V3_SWAP_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const V4_SWAP_EVENT = parseAbiItem(
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT);

const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const MAVERICK_V2_SWAP_TOPIC =
	'0x103ed084e94a44c8f5f6ba8e3011507c41063177e29949083c439777d8d63f60';
const MAVERICK_V1_SWAP_TOPIC =
	'0x3b841dc9ab51e3104bda4f61b41e4271192d22cd19da5ee6e292dc8e2744f713';
const UNIPOOL_SWAP_TOPIC =
	'0xdbad2ddd1b3cac36de15036b12f92d5f32b447fc9cd0c1a72467d15bc04dc812';

/**
 * Curve StableSwap `TokenExchange(address,int128,uint256,int128,uint256)`.
 * Emitted by every StableSwap-family pool (including StableNG), so tagging on
 * the event covers pools we have never seen before. Curve's crypto pools use a
 * same-named event with uint256 ids, which hashes differently and is not
 * matched here.
 */
const CURVE_TOKEN_EXCHANGE_TOPIC =
	'0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140';

// ─── Venue scanning ───

export interface VenueInfo {
	type: VenueType;
	v4PoolId?: string;
	v4FeeRaw?: number;
	infinityPoolId?: string;
	infinityFeeRaw?: number;
}

/**
 * Scan trace logs for Swap events and build a venue map.
 * Recognizes: Uni V3, PancakeSwap V3, Uni V4, V2, Aerodrome.
 */
export function scanVenues(logs: readonly LogLike[], recognizeForks: boolean): Map<string, VenueInfo> {
	const venues = new Map<string, VenueInfo>();

	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!.toLowerCase();
		const addr = log.address.toLowerCase();

		// Uni V3 Swap
		if (topic0 === UNI_V3_SWAP_TOPIC && log.topics.length >= 3) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'univ3' });
			}
		}

		// PancakeSwap V3 Swap (only when fork recognition enabled)
		if (recognizeForks && topic0 === PANCAKE_V3_SWAP_TOPIC && log.topics.length >= 3) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'pancakev3' });
			}
		}

		// Uni V4 Swap (emitted by PoolManager)
		if (topic0 === V4_SWAP_TOPIC && log.topics.length >= 3) {
			try {
				const decoded = decodeEventLog({
					abi: [V4_SWAP_EVENT],
					data: log.data,
					topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
				});
				const poolId = decoded.args.id as string;
				const fee = Number(decoded.args.fee);
				// Skip no-op swaps: a Swap that moved nothing carries a poolId that is
				// NOT the pool the trade used, and this map's entry drives BOTH the fee
				// and the mid read. See the guard in collectV4Swaps (receipt id 402).
				if ((decoded.args.amount0 as bigint) === 0n && (decoded.args.amount1 as bigint) === 0n) continue;
				// ⚠️ The V4 PoolManager is a SINGLETON: it emits Swap for every pool it
				// hosts, and this map is keyed by emitter address, so a multi-pool route
				// leaves only the LAST pool's fee and poolId here. That is not a
				// preference — it is a lossy collapse, and it corrupts both the LP fee
				// (v4FeeRaw) and the mid read (v4PoolId) for every pool but one.
				// Do not "fix" it by re-keying: legs are matched to venues by emitter
				// address throughout. The repair is decomposeRoute's V4 rescue, which
				// synthesizes one leg per poolId — see shouldAttemptV4Rescue.
				venues.set(addr, {
					type: 'univ4',
					v4PoolId: poolId,
					v4FeeRaw: fee,
				});
			} catch {
				// Malformed V4 event — set basic venue info
				if (!venues.has(addr)) {
					venues.set(addr, { type: 'univ4' });
				}
			}
		}

		// PancakeSwap Infinity Swap — emitted by the CLPoolManager, but the tokens
		// move through the VAULT, so it is the vault that appears in transfers and
		// therefore the vault we must register as the venue. Registering the
		// emitter instead would leave the vault's leg typed `unknown`.
		if (topic0 === INFINITY_SWAP_TOPIC && log.topics.length >= 3) {
			venues.set(PANCAKE_INFINITY_VAULT, { type: 'pancake_infinity' });
		}

		// V2 Swap
		if (topic0 === V2_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'univ2' });
			}
		}

		// Aerodrome Swap
		if (topic0 === AERODROME_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'aerodrome' });
			}
		}

		// Maverick V2 PoolSwap
		if (topic0 === MAVERICK_V2_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'maverickv2' });
			}
		}

		// Maverick V1 Swap
		if (topic0 === MAVERICK_V1_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'maverickv1' });
			}
		}

		// UniPool Swap
		if (topic0 === UNIPOOL_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'unipool' });
			}
		}

		// Curve TokenExchange
		if (topic0 === CURVE_TOKEN_EXCHANGE_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'curve_stableng' });
			}
		}
	}

	// Give the vault's collapsed leg the pool's identity IF, and only if, that
	// identity is unambiguous. With exactly one distinct Infinity pool touched,
	// the vault's leg IS that pool, so storing its poolId/fee lets it price
	// normally without needing the rescue. With two or more, storing any one of
	// them is the exact lossy collapse the V4 branch above already warns about
	// — leave the entry type-only and let decomposeRoute's Infinity rescue
	// synthesize per-pool legs instead.
	if (venues.has(PANCAKE_INFINITY_VAULT)) {
		const infinitySwaps = collectInfinitySwaps(logs);
		const distinctPoolIds = new Set(infinitySwaps.map((s) => s.poolId));
		if (distinctPoolIds.size === 1) {
			const swap = infinitySwaps[0]!;
			venues.set(PANCAKE_INFINITY_VAULT, {
				type: 'pancake_infinity',
				infinityPoolId: swap.poolId,
				infinityFeeRaw: swap.lpFeePips,
			});
		}
	}

	return venues;
}

export function addKnownVenuesFromTransfers(
	venues: Map<string, VenueInfo>,
	transfers: { from: string; to: string }[],
): void {
	for (const transfer of transfers) {
		for (const addr of [transfer.from, transfer.to]) {
			const venueType = classifyKnownVenueAddress(addr);
			if (venueType != null && !venues.has(addr.toLowerCase())) {
				venues.set(addr.toLowerCase(), { type: venueType });
			}
		}
	}
}

export async function addKnownFactoryVenuesFromTransfers(
	venues: Map<string, VenueInfo>,
	transfers: { from: string; to: string }[],
	factoryReader: (addr: string) => Promise<string | null> | string | null,
): Promise<void> {
	const candidates = new Set<string>();
	for (const transfer of transfers) {
		candidates.add(transfer.from.toLowerCase());
		candidates.add(transfer.to.toLowerCase());
	}

	// One factory() read per distinct counterparty, and a busy route has ~17 of
	// them — serially the longest single chain in a decode. They are independent,
	// so they go out together; the Map is then written in candidate order, since
	// venue insertion order flows through to leg order.
	const unresolved = [...candidates].filter((addr) => !venues.has(addr));
	const factories = await Promise.all(unresolved.map((addr) => factoryReader(addr)));
	for (const [i, addr] of unresolved.entries()) {
		const venueType = classifyV3Factory(factories[i]);
		if (venueType !== 'univ3') {
			venues.set(addr, { type: venueType });
		}
	}
}

export async function refineV3VenueTypes(
	venues: Map<string, VenueInfo>,
	factoryReader: (addr: string) => Promise<string | null> | string | null,
): Promise<void> {
	// Same fan-out as above. Snapshot the univ3 entries first: the loop below
	// writes back into `venues`, and iterating a Map while mutating it is only
	// safe because the keys already exist — the snapshot makes that explicit.
	const univ3 = [...venues].filter(([, info]) => info.type === 'univ3');
	const factories = await Promise.all(univ3.map(([addr]) => factoryReader(addr)));
	for (const [i, [addr, info]] of univ3.entries()) {
		const refinedType = classifyV3Factory(factories[i]);
		if (refinedType !== info.type) {
			venues.set(addr, { ...info, type: refinedType });
		}
	}
}
