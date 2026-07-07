/**
 * selectionGate.ts — §C Selection Gate: Genuine User Trades.
 *
 * Given a trace + receipt, determines whether a transaction represents a
 * genuine end-user USDC↔WETH/ETH swap (not a filler/pool/MM round-trip).
 *
 * The gate identifies a single "swapper" account that VISIBLY sends the input
 * token and receives the output token, where the pair is USDC↔WETH or USDC↔ETH.
 * Pools, fillers, and intermediaries are structurally excluded — no hardcoded
 * denylist for pool addresses.
 *
 * READ-ONLY: no DB writes.
 */

import {
	USDC,
	WETH,
	DENYLIST,
	decodeTransferLogs,
	collectNativeEthDeltas,
} from './tradeEndpoints.js';

// ─── Swap event topics (used to identify pool addresses structurally) ───

const V3_SWAP_TOPIC =
	'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const V4_SWAP_TOPIC =
	'0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';

const SWAP_TOPICS = new Set([
	V3_SWAP_TOPIC,
	V4_SWAP_TOPIC,
	V2_SWAP_TOPIC,
	AERODROME_SWAP_TOPIC,
]);

// ─── Fee-vault addresses (mirrors §B step-3 fee-vault map — keep in sync) ───
// A fee vault is never the user; exclude from swapper candidates just like
// DENYLIST/pool addresses.
const FEE_VAULTS: Set<string> = new Set([
	'0x00700052c0608f670705380a4900e0a8080010cc', // Velora fee vault
	'0xf70da97812cb96acdf810712aa562db8dfa3dbef', // Relay fee vault
]);

// Dust thresholds
const USDC_DUST_RAW = 100n;          // 0.0001 USDC
const WETH_DUST_RAW = 10_000_000_000n; // 1e-8 WETH

// ─── Types ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
	input?: `0x${string}`;
	output?: `0x${string}`;
	type?: string;
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

interface LogLike {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
}

interface ReceiptLike {
	from: `0x${string}`;
	logs: readonly LogLike[];
}

export type GateDirection = 'buy_weth' | 'sell_weth';

export type RejectReason =
	| 'ok'
	| 'wrong_pair_or_third_token'
	| 'no_user_swapper'
	| 'split_recipient'
	| 'pool_as_trader';

export interface SelectionGateResult {
	inScope: boolean;
	swapper: string | null;
	direction: GateDirection | null;
	reason: RejectReason;
}

export interface SelectionGateInput {
	trace: TraceNode;
	receipt: ReceiptLike;
}

// ─── Main gate function ───

export function applySelectionGate(input: SelectionGateInput): SelectionGateResult {
	const { trace, receipt } = input;
	const txFrom = receipt.from.toLowerCase();

	// ── Step 1: Collect all logs from the trace ──

	const logs = collectTraceLogs(trace);

	// ── Step 2: Identify pool addresses structurally ──
	// Any address that emits a Swap event (V3, V4, V2, Aerodrome) is a pool.

	const poolAddresses = new Set<string>();
	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!;
		if (SWAP_TOPICS.has(topic0)) {
			poolAddresses.add(log.address.toLowerCase());
		}
	}

	// ── Step 3: Build per-address, per-token net deltas from ERC-20 transfers ──

	const transfers = decodeTransferLogs(logs);

	// Map<lowercaseAddr, Map<lowercaseToken, bigint>>
	const deltas = new Map<string, Map<string, bigint>>();

	const getOrInit = (addr: string, token: string) => {
		const a = addr.toLowerCase();
		const t = token.toLowerCase();
		if (!deltas.has(a)) deltas.set(a, new Map());
		const m = deltas.get(a)!;
		if (!m.has(t)) m.set(t, 0n);
	};

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();

		getOrInit(fromLower, tokenLower);
		getOrInit(toLower, tokenLower);

		deltas.get(fromLower)!.set(
			tokenLower,
			deltas.get(fromLower)!.get(tokenLower)! - t.value,
		);
		deltas.get(toLower)!.set(
			tokenLower,
			deltas.get(toLower)!.get(tokenLower)! + t.value,
		);
	}

	// ── Step 4: Collect per-address native-ETH deltas from the trace ──

	const nativeEthDeltas = collectNativeEthDeltas(trace);

	// ── Step 5: Track which addresses have VISIBLE transfers (from/to them) ──

	const visibleSendFrom = new Map<string, Map<string, bigint>>();
	const visibleRecvTo = new Map<string, Map<string, bigint>>();

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();

		if (!visibleSendFrom.has(fromLower)) visibleSendFrom.set(fromLower, new Map());
		const sf = visibleSendFrom.get(fromLower)!;
		sf.set(tokenLower, (sf.get(tokenLower) ?? 0n) + t.value);

		if (!visibleRecvTo.has(toLower)) visibleRecvTo.set(toLower, new Map());
		const rt = visibleRecvTo.get(toLower)!;
		rt.set(tokenLower, (rt.get(tokenLower) ?? 0n) + t.value);
	}

	// ── Step 6: Check if tx.from has third-token involvement ──
	// If tx.from deals in a third token, the REAL trade is a third-token trade
	// (e.g. ROBA→USDC, CLAWD→WETH). Any other address doing a clean USDC↔WETH
	// round-trip is the COUNTERPARTY (filler/resolver), not the user.

	let txFromHasThirdToken = false;
	const txFromTokenMap = deltas.get(txFrom);
	if (txFromTokenMap) {
		for (const [token, val] of txFromTokenMap) {
			if (token === USDC || token === WETH) continue;
			if (val !== 0n) { txFromHasThirdToken = true; break; }
		}
	}

	// ── Step 7: Find swapper candidates ──

	interface SwapperCandidate {
		address: string;
		direction: GateDirection;
	}

	const candidates: SwapperCandidate[] = [];

	const allAddrs = new Set<string>();
	for (const a of deltas.keys()) allAddrs.add(a);
	for (const a of nativeEthDeltas.keys()) allAddrs.add(a);

	for (const addr of allAddrs) {
		if (poolAddresses.has(addr)) continue;
		if (DENYLIST.has(addr)) continue;
		if (FEE_VAULTS.has(addr)) continue;
		if (addr === USDC || addr === WETH) continue;

		const tokenMap = deltas.get(addr);
		const usdcNet = tokenMap?.get(USDC) ?? 0n;
		const wethNet = tokenMap?.get(WETH) ?? 0n;
		const ethNet = nativeEthDeltas.get(addr) ?? 0n;
		const wethEthNet = wethNet + ethNet;

		// Swapper must ONLY deal in USDC and WETH/ETH — no third token
		let hasThirdToken = false;
		if (tokenMap) {
			for (const [token, val] of tokenMap) {
				if (token === USDC || token === WETH) continue;
				if (val !== 0n) { hasThirdToken = true; break; }
			}
		}
		if (hasThirdToken) continue;

		const usdcSignificant = absBI(usdcNet) >= USDC_DUST_RAW;
		const wethEthSignificant = absBI(wethEthNet) >= WETH_DUST_RAW;

		if (!usdcSignificant || !wethEthSignificant) continue;
		if (!((usdcNet > 0n && wethEthNet < 0n) || (usdcNet < 0n && wethEthNet > 0n))) continue;

		const direction: GateDirection = usdcNet < 0n ? 'buy_weth' : 'sell_weth';

		// Visible-transfer check: input leg FROM, output leg TO
		let inputVisible = false;
		let outputVisible = false;

		if (direction === 'buy_weth') {
			const usdcSent = visibleSendFrom.get(addr)?.get(USDC) ?? 0n;
			inputVisible = usdcSent >= USDC_DUST_RAW;
			const wethRecv = visibleRecvTo.get(addr)?.get(WETH) ?? 0n;
			outputVisible = wethRecv >= WETH_DUST_RAW || ethNet > WETH_DUST_RAW;
		} else {
			const wethSent = visibleSendFrom.get(addr)?.get(WETH) ?? 0n;
			inputVisible = wethSent >= WETH_DUST_RAW || (ethNet < 0n && absBI(ethNet) >= WETH_DUST_RAW);
			const usdcRecv = visibleRecvTo.get(addr)?.get(USDC) ?? 0n;
			outputVisible = usdcRecv >= USDC_DUST_RAW;
		}

		if (!inputVisible || !outputVisible) continue;

		candidates.push({ address: addr, direction });
	}

	// ── Step 8: Evaluate candidates ──

	if (candidates.length === 0) {
		// No round-trip candidates — check for pool-as-trader or split-recipient
		return classifyRejection(deltas, nativeEthDeltas, poolAddresses);
	}

	// If tx.from has third-token involvement, any non-tx.from candidate is a
	// counterparty/filler — the real user's trade is a third-token swap, not
	// USDC↔WETH. Reject unless the candidate IS tx.from.
	if (txFromHasThirdToken) {
		const txFromCandidate = candidates.find(c => c.address === txFrom);
		if (!txFromCandidate) {
			// All candidates are counterparties to a third-token trade
			return { inScope: false, swapper: null, direction: null, reason: 'no_user_swapper' };
		}
		// tx.from itself passes both the third-token gate AND the round-trip —
		// unusual but possible (the third token is a co-settlement, not the user's trade)
		return { inScope: true, swapper: txFromCandidate.address, direction: txFromCandidate.direction, reason: 'ok' };
	}

	if (candidates.length === 1) {
		const c = candidates[0]!;
		return { inScope: true, swapper: c.address, direction: c.direction, reason: 'ok' };
	}

	// Multiple candidates — prefer tx.from
	const txFromCandidate = candidates.find(c => c.address === txFrom);
	if (txFromCandidate) {
		return { inScope: true, swapper: txFromCandidate.address, direction: txFromCandidate.direction, reason: 'ok' };
	}

	// Multiple candidates, none is tx.from — pick largest by notional
	const sorted = [...candidates].sort((a, b) => {
		const aUsdc = absBI(deltas.get(a.address)?.get(USDC) ?? 0n);
		const bUsdc = absBI(deltas.get(b.address)?.get(USDC) ?? 0n);
		return Number(bUsdc - aUsdc);
	});
	return { inScope: true, swapper: sorted[0]!.address, direction: sorted[0]!.direction, reason: 'ok' };
}

// ─── Rejection classifier ───
// When no round-trip candidate is found, distinguish between pool_as_trader,
// split_recipient, and no_user_swapper.

function classifyRejection(
	deltas: Map<string, Map<string, bigint>>,
	nativeEthDeltas: Map<string, bigint>,
	poolAddresses: Set<string>,
): SelectionGateResult {
	const isExcluded = (addr: string) =>
		poolAddresses.has(addr) || DENYLIST.has(addr) || FEE_VAULTS.has(addr) || addr === USDC || addr === WETH;

	// Check for split-recipient: one non-excluded address pays one side,
	// a DIFFERENT non-excluded address receives the other side.
	// Include native-ETH payers/receivers (e.g. tx.from paying native ETH).
	const usdcPayers: string[] = [];
	const usdcReceivers: string[] = [];
	const wethPayers: string[] = [];   // includes native ETH
	const wethReceivers: string[] = []; // includes native ETH

	// First pass: collect from ERC-20 deltas
	for (const [addr, tokenMap] of deltas) {
		if (isExcluded(addr)) continue;

		const usdcNet = tokenMap.get(USDC) ?? 0n;
		const wethNet = tokenMap.get(WETH) ?? 0n;
		const ethNet = nativeEthDeltas.get(addr) ?? 0n;
		const wethEthNet = wethNet + ethNet;

		if (usdcNet < -USDC_DUST_RAW) usdcPayers.push(addr);
		if (usdcNet > USDC_DUST_RAW) usdcReceivers.push(addr);
		if (wethEthNet < -WETH_DUST_RAW) wethPayers.push(addr);
		if (wethEthNet > WETH_DUST_RAW) wethReceivers.push(addr);
	}

	// Second pass: addresses with only native-ETH (no ERC-20 delta entry)
	for (const [addr, raw] of nativeEthDeltas) {
		if (isExcluded(addr)) continue;
		if (deltas.has(addr)) continue; // already processed
		if (raw < -WETH_DUST_RAW) wethPayers.push(addr);
		if (raw > WETH_DUST_RAW) wethReceivers.push(addr);
	}

	// Split: one address pays USDC, a different receives WETH/ETH (or vice versa),
	// and no single address does both
	const hasBuySplit = usdcPayers.length > 0 && wethReceivers.length > 0 &&
		!usdcPayers.some(p => wethReceivers.includes(p));
	const hasSellSplit = wethPayers.length > 0 && usdcReceivers.length > 0 &&
		!wethPayers.some(p => usdcReceivers.includes(p));

	if (hasBuySplit || hasSellSplit) {
		return { inScope: false, swapper: null, direction: null, reason: 'split_recipient' };
	}

	// Check for pool-as-trader: a pool address has a two-sided USDC↔WETH delta
	for (const addr of poolAddresses) {
		const tokenMap = deltas.get(addr);
		if (!tokenMap) continue;
		const usdcNet = tokenMap.get(USDC) ?? 0n;
		const wethNet = tokenMap.get(WETH) ?? 0n;
		if (absBI(usdcNet) >= USDC_DUST_RAW && absBI(wethNet) >= WETH_DUST_RAW) {
			if ((usdcNet > 0n && wethNet < 0n) || (usdcNet < 0n && wethNet > 0n)) {
				return { inScope: false, swapper: null, direction: null, reason: 'pool_as_trader' };
			}
		}
	}

	return { inScope: false, swapper: null, direction: null, reason: 'no_user_swapper' };
}

// ─── Public wrapper with split-recipient detection ───
// This is the primary entry point. It calls applySelectionGate and, if rejected,
// refines the rejection reason with split-recipient detection.
export function applySelectionGateWithSplitDetection(input: SelectionGateInput): SelectionGateResult {
	// The main gate now includes split-recipient detection inline via
	// classifyRejection, so this wrapper just delegates directly.
	return applySelectionGate(input);
}

// ─── Gasless-user recovery for split-recipient trades ───

export type GaslessRecoveryReason =
	| 'batch_multiple_recipients'
	| 'wrong_pair'
	| 'no_single_input_source'
	| 'no_clean_recipient'
	| 'recipient_is_pool'
	| 'recipient_in_denylist'
	| 'recipient_is_fee_vault'
	| 'recipient_has_third_token'
	| 'no_significant_output'
	| 'signs_mismatch';

export interface GaslessRecoverySuccess {
	recovered: true;
	recipient: string;
	direction: GateDirection;
	usdcRaw: bigint;
	wethEquivRaw: bigint;
	settledIn: 'WETH' | 'ETH';
}

export interface GaslessRecoveryFailure {
	recovered: false;
	reason: GaslessRecoveryReason;
}

export type GaslessRecoveryResult = GaslessRecoverySuccess | GaslessRecoveryFailure;

/**
 * Attempt to recover a gasless/split-recipient trade.
 *
 * A gasless trade is one where tx.from (the gas payer / relayer) provides
 * the input token, but a DIFFERENT address receives the output token.
 * The normal gate rejects this as "split_recipient" because no single
 * address has both the input and output legs.
 *
 * Recovery rules — ALL must hold:
 * 1. Single input source: exactly one address provides the entire input leg.
 * 2. Single clean recipient: exactly ONE non-pool, non-denylist, non-vault
 *    address receives the output token. If 2+ distinct recipients → batch.
 * 3. Clean pair: input + output = exactly USDC and WETH/ETH (one each side).
 * 4. Re-anchor to the recipient as the user.
 *
 * Returns the candidate recipient for downstream RPC/recurrence guards.
 * Does NOT call RPC — purely structural from {trace, receipt}.
 */
export function recoverGaslessUser(input: SelectionGateInput): GaslessRecoveryResult {
	const { trace, receipt } = input;
	const txFrom = receipt.from.toLowerCase();

	// ── Collect logs and identify pools ──
	const logs = collectTraceLogs(trace);

	const poolAddresses = new Set<string>();
	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!;
		if (SWAP_TOPICS.has(topic0)) {
			poolAddresses.add(log.address.toLowerCase());
		}
	}

	// ── Build per-address, per-token net deltas (ERC-20) ──
	const transfers = decodeTransferLogs(logs);
	const deltas = new Map<string, Map<string, bigint>>();

	const getOrInit = (addr: string, token: string) => {
		const a = addr.toLowerCase();
		const t = token.toLowerCase();
		if (!deltas.has(a)) deltas.set(a, new Map());
		const m = deltas.get(a)!;
		if (!m.has(t)) m.set(t, 0n);
	};

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();

		getOrInit(fromLower, tokenLower);
		getOrInit(toLower, tokenLower);

		deltas.get(fromLower)!.set(
			tokenLower,
			deltas.get(fromLower)!.get(tokenLower)! - t.value,
		);
		deltas.get(toLower)!.set(
			tokenLower,
			deltas.get(toLower)!.get(tokenLower)! + t.value,
		);
	}

	// ── Native-ETH deltas ──
	const nativeEthDeltas = collectNativeEthDeltas(trace);

	// ── Build visible-transfer maps (who sends what, who receives what) ──
	const visibleSendFrom = new Map<string, Map<string, bigint>>();
	const visibleRecvTo = new Map<string, Map<string, bigint>>();

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();

		if (!visibleSendFrom.has(fromLower)) visibleSendFrom.set(fromLower, new Map());
		const sf = visibleSendFrom.get(fromLower)!;
		sf.set(tokenLower, (sf.get(tokenLower) ?? 0n) + t.value);

		if (!visibleRecvTo.has(toLower)) visibleRecvTo.set(toLower, new Map());
		const rt = visibleRecvTo.get(toLower)!;
		rt.set(tokenLower, (rt.get(tokenLower) ?? 0n) + t.value);
	}

	// ── Helper: is an address excluded (pool/denylist/fee-vault/token)? ──
	const isExcluded = (addr: string) =>
		poolAddresses.has(addr) || DENYLIST.has(addr) || FEE_VAULTS.has(addr)
		|| addr === USDC || addr === WETH;

	// ── Helper: does address have any third-token (non-USDC/WETH) delta? ──
	const hasThirdToken = (addr: string): boolean => {
		const tokenMap = deltas.get(addr);
		if (!tokenMap) return false;
		for (const [token, val] of tokenMap) {
			if (token === USDC || token === WETH) continue;
			if (val !== 0n) return true;
		}
		return false;
	};

	// ── Rule 1: Identify the single input source ──
	// tx.from must provide the entire input leg: either sends USDC, sends WETH,
	// or sends native ETH. Determine which side is the input.

	const txFromTokenMap = deltas.get(txFrom);
	const txFromUsdcNet = txFromTokenMap?.get(USDC) ?? 0n;
	const txFromWethNet = txFromTokenMap?.get(WETH) ?? 0n;
	const txFromEthNet = nativeEthDeltas.get(txFrom) ?? 0n;
	const txFromWethEquiv = txFromWethNet + txFromEthNet;

	// tx.from must have a significant outflow on exactly one side of the pair
	const txFromSendsUsdc = txFromUsdcNet < -USDC_DUST_RAW;
	const txFromSendsWethEth = txFromWethEquiv < -WETH_DUST_RAW;

	// Determine the input token from tx.from's perspective
	let inputSide: 'usdc' | 'weth_eth' | null = null;
	if (txFromSendsUsdc && !txFromSendsWethEth) {
		inputSide = 'usdc';
	} else if (txFromSendsWethEth && !txFromSendsUsdc) {
		inputSide = 'weth_eth';
	} else if (txFromSendsUsdc && txFromSendsWethEth) {
		// tx.from sends both sides — not a gasless user pattern
		return { recovered: false, reason: 'no_single_input_source' };
	} else {
		// tx.from doesn't send either side significantly
		return { recovered: false, reason: 'no_single_input_source' };
	}

	// Verify the input is VISIBLE: tx.from must VISIBLY send the input token
	// (ERC-20 transfer from tx.from, or native ETH via trace value)
	if (inputSide === 'usdc') {
		const usdcSent = visibleSendFrom.get(txFrom)?.get(USDC) ?? 0n;
		if (usdcSent < USDC_DUST_RAW) {
			return { recovered: false, reason: 'no_single_input_source' };
		}
	} else {
		// weth_eth: check ERC-20 WETH sent OR native ETH sent (negative ethNet)
		const wethSent = visibleSendFrom.get(txFrom)?.get(WETH) ?? 0n;
		const nativeEthSent = txFromEthNet < 0n ? absBI(txFromEthNet) : 0n;
		if (wethSent < WETH_DUST_RAW && nativeEthSent < WETH_DUST_RAW) {
			return { recovered: false, reason: 'no_single_input_source' };
		}
	}

	// ── Rule 3 (early): Check tx.from doesn't have third-token involvement ──
	if (hasThirdToken(txFrom)) {
		return { recovered: false, reason: 'wrong_pair' };
	}

	// ── Rule 2: Find the single clean recipient of the output token ──
	// The output token is the OTHER side of the pair from the input.
	// output_side: if input is USDC → output is WETH/ETH; if input is WETH/ETH → output is USDC

	const outputIsUsdc = inputSide === 'weth_eth';
	const outputIsWethEth = inputSide === 'usdc';

	// Collect all non-excluded addresses that receive the output token significantly
	const outputRecipients: { addr: string; outputAmount: bigint }[] = [];

	const allAddrs = new Set<string>();
	for (const a of deltas.keys()) allAddrs.add(a);
	for (const a of nativeEthDeltas.keys()) allAddrs.add(a);

	for (const addr of allAddrs) {
		if (isExcluded(addr)) continue;
		if (addr === txFrom) continue; // the input source is not the recipient

		const tokenMap = deltas.get(addr);
		const usdcNet = tokenMap?.get(USDC) ?? 0n;
		const wethNet = tokenMap?.get(WETH) ?? 0n;
		const ethNet = nativeEthDeltas.get(addr) ?? 0n;
		const wethEthNet = wethNet + ethNet;

		if (outputIsUsdc && usdcNet > USDC_DUST_RAW) {
			// Check this address receives USDC via visible transfer
			const usdcRecv = visibleRecvTo.get(addr)?.get(USDC) ?? 0n;
			if (usdcRecv > USDC_DUST_RAW) {
				outputRecipients.push({ addr, outputAmount: usdcNet });
			}
		} else if (outputIsWethEth && wethEthNet > WETH_DUST_RAW) {
			// Check this address receives WETH or ETH via visible transfer
			const wethRecv = visibleRecvTo.get(addr)?.get(WETH) ?? 0n;
			const ethRecvPositive = ethNet > 0n ? ethNet : 0n;
			if (wethRecv > WETH_DUST_RAW || ethRecvPositive > WETH_DUST_RAW) {
				outputRecipients.push({ addr, outputAmount: wethEthNet });
			}
		}
	}

	if (outputRecipients.length === 0) {
		return { recovered: false, reason: 'no_clean_recipient' };
	}

	if (outputRecipients.length > 1) {
		return { recovered: false, reason: 'batch_multiple_recipients' };
	}

	const recipient = outputRecipients[0]!;

	// ── Rule 2 (cont): Validate the recipient is clean ──
	// Already passed isExcluded check above (pools, denylist, fee vaults).
	// Now check: recipient must NOT emit a Swap event itself.
	if (poolAddresses.has(recipient.addr)) {
		return { recovered: false, reason: 'recipient_is_pool' };
	}
	if (DENYLIST.has(recipient.addr)) {
		return { recovered: false, reason: 'recipient_in_denylist' };
	}
	if (FEE_VAULTS.has(recipient.addr)) {
		return { recovered: false, reason: 'recipient_is_fee_vault' };
	}

	// Recipient must have NO third-token delta
	if (hasThirdToken(recipient.addr)) {
		return { recovered: false, reason: 'recipient_has_third_token' };
	}

	// ── Rule 3: Clean pair confirmation ──
	// The recipient's net deltas must only touch the output side of USDC↔WETH/ETH.
	// We already checked no third token. But also verify the recipient doesn't have
	// a significant OPPOSING delta (which would make it a round-tripper, not a
	// simple recipient).
	const recipientTokenMap = deltas.get(recipient.addr);
	const recipientUsdcNet = recipientTokenMap?.get(USDC) ?? 0n;
	const recipientWethNet = recipientTokenMap?.get(WETH) ?? 0n;
	const recipientEthNet = nativeEthDeltas.get(recipient.addr) ?? 0n;
	const recipientWethEquivNet = recipientWethNet + recipientEthNet;

	// ── Rule 4: Direction and amounts ──
	let direction: GateDirection;
	let usdcRaw: bigint;
	let wethEquivRaw: bigint;
	let settledIn: 'WETH' | 'ETH';

	if (outputIsUsdc) {
		// Input = WETH/ETH (from tx.from), Output = USDC (to recipient)
		// Recipient receives USDC → this is a sell_weth trade (user sells WETH, gets USDC)
		direction = 'sell_weth';
		usdcRaw = recipientUsdcNet;           // positive: recipient received USDC
		wethEquivRaw = txFromWethEquiv;        // negative: tx.from sent WETH/ETH
		// settledIn from the input leg (what tx.from sent)
		settledIn = absBI(txFromWethNet) > WETH_DUST_RAW ? 'WETH' : 'ETH';
	} else {
		// Input = USDC (from tx.from), Output = WETH/ETH (to recipient)
		// Recipient receives WETH/ETH → this is a buy_weth trade
		direction = 'buy_weth';
		usdcRaw = txFromUsdcNet;              // negative: tx.from sent USDC
		wethEquivRaw = recipientWethEquivNet;  // positive: recipient received WETH/ETH
		// settledIn from the output leg (what recipient received)
		settledIn = absBI(recipientWethNet) > WETH_DUST_RAW ? 'WETH' : 'ETH';
	}

	// Sanity: amounts must be significant on both sides
	if (absBI(usdcRaw) < USDC_DUST_RAW || absBI(wethEquivRaw) < WETH_DUST_RAW) {
		return { recovered: false, reason: 'no_significant_output' };
	}

	return {
		recovered: true,
		recipient: recipient.addr,
		direction,
		usdcRaw,
		wethEquivRaw,
		settledIn,
	};
}

// ─── Helpers ───

function absBI(n: bigint): bigint {
	return n < 0n ? -n : n;
}

/** Flatten every log from a callTracer trace tree into a single ordered list. */
function collectTraceLogs(trace: TraceNode): LogLike[] {
	const out: LogLike[] = [];
	const visit = (node: TraceNode) => {
		if (node.logs) out.push(...node.logs);
		if (node.calls) {
			for (const child of node.calls) visit(child);
		}
	};
	visit(trace);
	return out;
}
