/**
 * Trader-EOA identification + batch/single-hop classifiers.
 * Spec §0.5 gate + §1 algorithm.
 *
 * Given the decoded transfers from a transaction (USDC/WETH only), identifies
 * the real trader wallet — the address with a clean two-sided net delta (sent
 * one token, received the other) that is NOT a known router/settlement/solver/pool.
 *
 * Also classifies:
 *   - is_batch_settlement: CoW GPv2Settlement or similar batch tx
 *   - is_single_hop: exactly one DEX Swap event in the receipt logs
 *
 * Two modes:
 *   - `identifyTrader()` — synchronous, pure heuristic (no RPC calls)
 *   - `identifyTraderWithCodeCheck()` — async, uses getCode to distinguish
 *     EOAs from contracts among candidates. Prefers EOAs when disambiguating.
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type { TransferEvent, Direction } from './decoder.js';

// ─── Denylist: known router / settlement / solver / infrastructure addresses ───
// These are never the real trader. Lowercase for comparison.

const COW_GPV2_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
const ENTRY_POINT_4337 = '0x0000000071727de22e5e9d8baf0edac6f37da032';

const USDC_LOWER = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_LOWER = '0x4200000000000000000000000000000000000006';

/**
 * Static denylist of addresses that should never be identified as the trader.
 * Includes: CoW settlement, 4337 EntryPoint, known aggregator routers.
 * The pool address is also denied (passed dynamically).
 */
const DENYLIST: Set<string> = new Set([
	COW_GPV2_SETTLEMENT,
	ENTRY_POINT_4337,
	// Odos V2
	'0x19ceead7105607cd444f5ad10dd51356436095a1',
	// 0x ExchangeProxy
	'0xdef1c0ded9bec7f1a1670819833240f027b25eff',
	// KyberSwap MetaAggregationRouterV2
	'0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
	// 1inch AggregationRouterV5
	'0x1111111254eeb25477b68fb85ed929f73a960582',
	// 1inch AggregationRouterV6
	'0x111111125421ca6dc452d289314280a0f8842a65',
	// Velora AugustusV6.2 (Paraswap)
	'0x6a000f20005980200259b80c5102003040001068',
	// Velora AugustusV5 (legacy)
	'0x59c7c832e96d2568bea6db468c1aadcbbda08a52',
	// Fabric v1
	'0x7c137a37742437d2212b7bd873ed135b5c4c61da',
	// Nordstern v1
	'0xc87de04e2ec1f4282dff2933a2d58199f688fc3d',
	// Relay v1
	'0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
	// USDC and WETH token contracts themselves (sometimes appear as from/to in
	// mint/burn or wrapping flows — never a trader)
	USDC_LOWER,
	WETH_LOWER,
	// Other Uniswap V3 WETH/USDC pools on Base (multi-hop routes split through
	// these; they have two-sided USDC/WETH deltas but are NOT traders).
	// The 5bps target pool (0xd0b5...) is denied dynamically via poolAddress.
	'0xb4cb800910b228ed3d0834cf79d697127bbb00e5', // 1bps WETH/USDC
	'0x6c561b446416e1a00e8e93e221854d6ea4171372', // 30bps WETH/USDC
	'0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69', // 100bps WETH/USDC
]);

// ─── Interfaces ───

export interface TraderIdentificationResult {
	/** The identified trader address, or null if none found. */
	traderAddress: `0x${string}` | null;
	/** Net USDC change for the trader (positive = received, negative = sent). */
	traderUsdcDelta: number;
	/** Net WETH change for the trader (positive = received, negative = sent). */
	traderWethDelta: number;
	/** True if this is a batch settlement (CoW etc.) — should be excluded from TCA. */
	isBatchSettlement: boolean;
	/** True if exactly one DEX Swap event in the receipt — single-hop trade. */
	isSingleHop: boolean;
	/** P_user = |USDC delta| / |WETH delta|, or null if no valid trader. */
	pUser: number | null;
	/** All per-address net deltas computed during identification (for debugging). */
	addressDeltas: AddressDelta[];
}

export interface AddressDelta {
	address: string;
	usdcDelta: bigint;
	wethDelta: bigint;
	isDenied: boolean;
	isTwoSided: boolean;
	/** Set by identifyTraderWithCodeCheck; undefined if not checked. */
	isContract?: boolean;
}

export interface TraderIdentificationResult_WithCodeInfo extends TraderIdentificationResult {
	/** Whether the identified trader address is a contract (vs EOA). */
	traderIsContract: boolean | null;
	/** Number of two-sided non-denied candidates found. >1 means ambiguity. */
	candidateCount: number;
}

export interface TraderIdentificationArgs {
	transfers: TransferEvent[];
	txFrom: string;
	poolAddress: string;
	/** All receipt log addresses that emitted a Swap event (for single-hop counting). */
	swapEventCount: number;
	/** Optional: the raw trace for CoW detection via tx.to or inner calls. */
	txTo: string | null;
}

// ─── Batch detection ───

/**
 * Detects whether this transaction is a CoW Protocol batch settlement or
 * similar multi-user batch. Detection:
 *   - tx.to is GPv2Settlement, OR
 *   - GPv2Settlement appears as the hub of transfers (most transfers have
 *     it as from or to).
 */
export function detectBatchSettlement(
	txTo: string | null,
	transfers: TransferEvent[],
): boolean {
	// Primary: tx.to is the settlement contract
	if (txTo && txTo.toLowerCase() === COW_GPV2_SETTLEMENT) return true;

	// Secondary: GPv2Settlement is the "hub" — appears in > 50% of transfers
	// as either from or to. This catches cases where the settlement is called
	// internally.
	if (transfers.length >= 4) {
		let cowTouches = 0;
		for (const t of transfers) {
			if (
				t.from.toLowerCase() === COW_GPV2_SETTLEMENT ||
				t.to.toLowerCase() === COW_GPV2_SETTLEMENT
			) {
				cowTouches++;
			}
		}
		if (cowTouches / transfers.length > 0.5) return true;
	}

	return false;
}

// ─── Single-hop detection ───

/**
 * A trade is single-hop if there is exactly one DEX Swap event in the
 * transaction receipt. The caller counts Swap events across all pool
 * addresses (not just our target pool).
 */
export function detectSingleHop(swapEventCount: number): boolean {
	return swapEventCount === 1;
}

// ─── Trader-EOA identification ───

/**
 * Build the full denylist for a specific transaction, including the pool
 * address and any dynamic additions.
 */
function buildDenySet(poolAddress: string): Set<string> {
	const deny = new Set(DENYLIST);
	deny.add(poolAddress.toLowerCase());
	return deny;
}

/**
 * Compute per-address net deltas for USDC and WETH across all transfers.
 */
function computeNetDeltas(
	transfers: TransferEvent[],
): Map<string, { usdc: bigint; weth: bigint }> {
	const deltas = new Map<string, { usdc: bigint; weth: bigint }>();

	const getOrInit = (addr: string) => {
		const lower = addr.toLowerCase();
		let entry = deltas.get(lower);
		if (!entry) {
			entry = { usdc: 0n, weth: 0n };
			deltas.set(lower, entry);
		}
		return entry;
	};

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const isUsdc = tokenLower === USDC_LOWER;
		const isWeth = tokenLower === WETH_LOWER;
		if (!isUsdc && !isWeth) continue;

		const fromEntry = getOrInit(t.from);
		const toEntry = getOrInit(t.to);

		if (isUsdc) {
			fromEntry.usdc -= t.value;
			toEntry.usdc += t.value;
		} else {
			fromEntry.weth -= t.value;
			toEntry.weth += t.value;
		}
	}

	return deltas;
}

/**
 * Check if an address has a "clean two-sided" delta: one token goes up,
 * the other goes down (sent A, received B). Both must be non-zero.
 */
function isTwoSided(usdc: bigint, weth: bigint): boolean {
	if (usdc === 0n || weth === 0n) return false;
	// One positive, one negative = two-sided swap
	return (usdc > 0n && weth < 0n) || (usdc < 0n && weth > 0n);
}

/**
 * Main trader identification logic.
 *
 * Algorithm:
 * 1. Compute net USDC/WETH delta for every address involved in transfers.
 * 2. Filter out denied addresses (routers, settlement, pool, tokens).
 * 3. Among remaining, find addresses with clean two-sided deltas.
 * 4. If exactly one candidate: that's the trader.
 * 5. If multiple candidates: pick the one with the largest notional (|USDC delta|).
 * 6. If no two-sided candidates among non-denied: check tx.from as fallback
 *    (it might be a smart-contract wallet or 4337 sender not in the denylist).
 */
export function identifyTrader(args: TraderIdentificationArgs): TraderIdentificationResult {
	const isBatchSettlement = detectBatchSettlement(args.txTo, args.transfers);
	const isSingleHop = detectSingleHop(args.swapEventCount);

	const deny = buildDenySet(args.poolAddress);
	const deltas = computeNetDeltas(args.transfers);

	// Build debug array of all address deltas
	const addressDeltas: AddressDelta[] = [];
	const candidates: Array<{ address: string; usdc: bigint; weth: bigint }> = [];

	for (const [addr, d] of deltas) {
		const isDenied = deny.has(addr);
		const twoSided = isTwoSided(d.usdc, d.weth);
		addressDeltas.push({
			address: addr,
			usdcDelta: d.usdc,
			wethDelta: d.weth,
			isDenied,
			isTwoSided: twoSided,
		});

		if (!isDenied && twoSided) {
			candidates.push({ address: addr, usdc: d.usdc, weth: d.weth });
		}
	}

	let trader: { address: string; usdc: bigint; weth: bigint } | null = null;

	if (candidates.length === 1) {
		trader = candidates[0]!;
	} else if (candidates.length > 1) {
		// Multiple two-sided, non-denied candidates. Pick largest by |USDC delta|.
		trader = candidates.reduce<{ address: string; usdc: bigint; weth: bigint }>((best, c) =>
			abs(c.usdc) > abs(best.usdc) ? c : best,
		candidates[0]!);
	} else {
		// No two-sided candidate found. Fallback: check tx.from if not denied.
		const txFromLower = args.txFrom.toLowerCase();
		if (!deny.has(txFromLower)) {
			const fromDelta = deltas.get(txFromLower);
			if (fromDelta) {
				// Accept even if not cleanly two-sided (e.g., proxy routed trade
				// where WETH lands elsewhere — at least USDC delta is visible)
				trader = { address: txFromLower, usdc: fromDelta.usdc, weth: fromDelta.weth };
			}
		}
	}

	if (!trader) {
		return {
			traderAddress: null,
			traderUsdcDelta: 0,
			traderWethDelta: 0,
			isBatchSettlement,
			isSingleHop,
			pUser: null,
			addressDeltas,
		};
	}

	const traderUsdcDelta = Number(trader.usdc) / 1e6;
	const traderWethDelta = Number(trader.weth) / 1e18;

	// P_user = |USDC delta| / |WETH delta| — USDC per WETH
	let pUser: number | null = null;
	if (trader.weth !== 0n && trader.usdc !== 0n) {
		pUser = Math.abs(traderUsdcDelta) / Math.abs(traderWethDelta);
	}

	return {
		traderAddress: trader.address as `0x${string}`,
		traderUsdcDelta,
		traderWethDelta,
		isBatchSettlement,
		isSingleHop,
		pUser,
		addressDeltas,
	};
}

function abs(n: bigint): bigint {
	return n < 0n ? -n : n;
}

// ─── Exports for the spec's signedDeviation helper ───

/**
 * Signed deviation in basis points: positive = cost to user.
 * Same convention as processSwap.ts's signedDeviationBps.
 */
export function aggFeeBps(
	direction: Direction,
	pPool: number,
	pUser: number,
): number {
	// sell_weth: user received USDC; lower P_user = fewer USDC = cost
	// buy_weth:  user paid USDC; higher P_user = more USDC = cost
	const deviation =
		direction === 'sell_weth'
			? pPool - pUser
			: pUser - pPool;
	return (deviation / pPool) * 10_000;
}

// ─── Async variant with on-chain getCode EOA check ───

/**
 * Enhanced trader identification that uses `eth_getCode` to distinguish
 * EOAs from contracts among two-sided candidates. Prefers EOAs.
 *
 * Falls back to the largest-notional contract if no EOA candidates exist
 * (smart-contract wallet trades where the wallet itself is the "trader").
 */
export async function identifyTraderWithCodeCheck(
	args: TraderIdentificationArgs & { rpcUrl: string },
): Promise<TraderIdentificationResult_WithCodeInfo> {
	// Start with the sync heuristic to get candidates and deltas
	const isBatchSettlement = detectBatchSettlement(args.txTo, args.transfers);
	const isSingleHop = detectSingleHop(args.swapEventCount);

	const deny = buildDenySet(args.poolAddress);
	const deltas = computeNetDeltas(args.transfers);

	const addressDeltas: AddressDelta[] = [];
	const candidates: Array<{ address: string; usdc: bigint; weth: bigint }> = [];

	for (const [addr, d] of deltas) {
		const isDenied = deny.has(addr);
		const twoSided = isTwoSided(d.usdc, d.weth);
		addressDeltas.push({
			address: addr,
			usdcDelta: d.usdc,
			wethDelta: d.weth,
			isDenied,
			isTwoSided: twoSided,
		});

		if (!isDenied && twoSided) {
			candidates.push({ address: addr, usdc: d.usdc, weth: d.weth });
		}
	}

	// Check getCode for all candidates + tx.from
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
	const addressesToCheck = new Set<string>();
	for (const c of candidates) addressesToCheck.add(c.address);
	addressesToCheck.add(args.txFrom.toLowerCase());

	const codeMap = new Map<string, boolean>(); // address -> isContract
	await Promise.all(
		[...addressesToCheck].map(async (addr) => {
			try {
				const code = await client.getCode({ address: addr as `0x${string}` });
				codeMap.set(addr, code !== undefined && code !== '0x' && code.length > 2);
			} catch {
				codeMap.set(addr, false); // assume EOA on error
			}
		}),
	);

	// Annotate addressDeltas with isContract
	for (const ad of addressDeltas) {
		if (codeMap.has(ad.address)) {
			ad.isContract = codeMap.get(ad.address) === true;
		}
	}

	// Split candidates into EOAs and contracts
	type Candidate = { address: string; usdc: bigint; weth: bigint };
	const eoaCandidates = candidates.filter((c) => !codeMap.get(c.address));
	const contractCandidates = candidates.filter((c) => codeMap.get(c.address));

	let trader: Candidate | null = null;
	let traderIsContract: boolean | null = null;

	if (eoaCandidates.length === 1) {
		trader = eoaCandidates[0]!;
		traderIsContract = false;
	} else if (eoaCandidates.length > 1) {
		// Multiple EOA candidates — pick largest notional
		trader = eoaCandidates.reduce<Candidate>((best, c) =>
			abs(c.usdc) > abs(best.usdc) ? c : best,
		eoaCandidates[0]!);
		traderIsContract = false;
	} else if (contractCandidates.length > 0) {
		// No EOA candidates; pick largest contract (smart-contract wallet)
		trader = contractCandidates.reduce<Candidate>((best, c) =>
			abs(c.usdc) > abs(best.usdc) ? c : best,
		contractCandidates[0]!);
		traderIsContract = true;
	} else {
		// No two-sided candidates at all. Fallback: tx.from
		const txFromLower = args.txFrom.toLowerCase();
		if (!deny.has(txFromLower)) {
			const fromDelta = deltas.get(txFromLower);
			if (fromDelta) {
				trader = { address: txFromLower, usdc: fromDelta.usdc, weth: fromDelta.weth };
				traderIsContract = codeMap.get(txFromLower) ?? null;
			}
		}
	}

	if (!trader) {
		return {
			traderAddress: null,
			traderUsdcDelta: 0,
			traderWethDelta: 0,
			isBatchSettlement,
			isSingleHop,
			pUser: null,
			addressDeltas,
			traderIsContract: null,
			candidateCount: candidates.length,
		};
	}

	const traderUsdcDelta = Number(trader.usdc) / 1e6;
	const traderWethDelta = Number(trader.weth) / 1e18;

	let pUser: number | null = null;
	if (trader.weth !== 0n && trader.usdc !== 0n) {
		pUser = Math.abs(traderUsdcDelta) / Math.abs(traderWethDelta);
	}

	return {
		traderAddress: trader.address as `0x${string}`,
		traderUsdcDelta,
		traderWethDelta,
		isBatchSettlement,
		isSingleHop,
		pUser,
		addressDeltas,
		traderIsContract: traderIsContract,
		candidateCount: candidates.length,
	};
}
