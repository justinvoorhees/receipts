/**
 * Protocol-aware settlement decoders. Authoritative beneficiary identity from a
 * protocol's own event, mirroring resolveAggregator's "declaration, not
 * inference" discipline. Seeded with UniswapX only; add a decoder per protocol.
 *
 * UniswapX BaseReactor emits `Fill(bytes32 orderHash, address filler, address
 * swapper, uint256 nonce)` — all three addresses indexed, so `swapper` is
 * topics[3] and no data decode is needed. Matching keys off the LOG EMITTER
 * being a known reactor (not tx.to), so a filler contract that is itself tx.to
 * and calls the reactor internally still matches.
 */
import { readFile } from 'node:fs/promises';
import { log } from './log.js';

export type LogLite = { address: string; topics: readonly string[] };

export const FILL_TOPIC0 = '0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66';

const topicToAddress = (t: string): string => ('0x' + t.slice(-40)).toLowerCase();

/** Lowercased swapper iff exactly one Fill from a known reactor; else null. */
export function decodeUniswapXBeneficiary(
	logs: readonly LogLite[],
	reactors: ReadonlySet<string>,
): string | null {
	const fills = logs.filter(
		(l) => l.topics[0] === FILL_TOPIC0 && l.topics.length >= 4 && reactors.has(l.address.toLowerCase()),
	);
	if (fills.length !== 1) return null; // 0 = not UniswapX; >1 = batch (out of scope)
	return topicToAddress(fills[0]!.topics[3]!);
}

/** ERC-4337 EntryPoint: `UserOperationEvent(bytes32 indexed userOpHash,
 *  address indexed sender, address indexed paymaster, uint256 nonce, bool
 *  success, uint256 actualGasCost, uint256 actualGasUsed)`. `sender` is the
 *  smart account whose operation this is — the trade's beneficiary. The first
 *  three args are indexed, so `sender` is topics[2] with no data decode.
 *  Identical ABI across EntryPoint v0.6/v0.7, so one topic0 covers both. */
export const USEROP_TOPIC0 = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';

/**
 * Lowercased UserOperation sender iff exactly one UserOperationEvent was emitted
 * by a known EntryPoint; else null.
 *
 * Keyed off the LOG EMITTER being an allowlisted EntryPoint, not tx.to, so a
 * bundler-owned wrapper contract that calls `handleOps` internally still
 * matches — and so an arbitrary contract cannot mint a beneficiary by replaying
 * the topic (same discipline as the reactor allowlist).
 *
 * A bundle carrying more than one UserOperation is deliberately out of scope:
 * the receipt describes ONE trade, and picking among several senders would be a
 * guess. Fail closed and let the caller fall through.
 */
export function decodeErc4337Beneficiary(
	logs: readonly LogLite[],
	entryPoints: ReadonlySet<string>,
): string | null {
	const ops = logs.filter(
		(l) => l.topics[0] === USEROP_TOPIC0 && l.topics.length >= 3 && entryPoints.has(l.address.toLowerCase()),
	);
	if (ops.length !== 1) return null; // 0 = not a UserOp tx; >1 = bundle (out of scope)
	return topicToAddress(ops[0]!.topics[2]!);
}

/**
 * Cross-chain bridge markers.
 *
 * Relay's approval proxy and multicaller emit `(from, to, token, amount, id)`
 * when they move a leg's tokens; its escrow emits `(depositor, token, amount,
 * requestId)` when funds are deposited to be delivered on another chain. Either
 * one identifies a transaction as HALF of a cross-chain trade — the counterpart
 * leg is on a different chain and is not in this trace.
 *
 * That is why such a transaction cannot produce a receipt: no address nets a
 * clean token-in/token-out pair, because the payer and the receiver are on
 * different chains by construction. It is a distinct fact from "not a swap" —
 * an origin leg frequently does swap on Base before bridging the output onward.
 */
export const BRIDGE_TRANSFER_TOPIC0 = '0xafbab204e8271965231d37baed9b1abca8725b7409c70314455f68bc89142b91';
export const BRIDGE_DEPOSIT_TOPIC0 = '0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1';

/**
 * True iff a log carrying one of the bridge topics was emitted BY an
 * allowlisted bridge address.
 *
 * Keyed off the emitter, never topic0 alone — any contract can replay a topic,
 * and this decides a user-facing claim about the transaction. Same discipline
 * as the reactor and EntryPoint allowlists.
 *
 * Deliberately a boolean, not an endpoint pair: identifying WHICH leg this is,
 * and pairing it with its counterpart, needs the request-id join and a
 * cross-chain data source. This answers only "is this half of a cross-chain
 * trade", which is all the failure notice claims.
 *
 * ⚠️ A same-chain Relay swap emits BRIDGE_TRANSFER too. Those resolve normally
 * via resolveTrader tier 1 (the trader is both payer and receiver), so
 * classifyTransaction — which runs only on a miss — does not see them. If one
 * ever misses for an unrelated reason it would be mislabelled cross-chain;
 * separating the two needs the same request-id pairing named above.
 */
export function hasBridgeLegMarker(
	logs: readonly LogLite[],
	bridges: ReadonlySet<string>,
): boolean {
	return logs.some(
		(l) =>
			(l.topics[0] === BRIDGE_TRANSFER_TOPIC0 || l.topics[0] === BRIDGE_DEPOSIT_TOPIC0) &&
			bridges.has(l.address.toLowerCase()),
	);
}

export interface BridgesConfig {
	_comment: string;
	chainId: number;
	bridges: string[];
}

export function parseBridges(json: string): Set<string> {
	const parsed = JSON.parse(json) as Partial<BridgesConfig>;
	const out = new Set<string>();
	for (const a of parsed.bridges ?? []) out.add(a.toLowerCase());
	return out;
}

/** Load the bridge allowlist; degrade to an empty set on any error (never
 *  throw) — matches loadReactors/loadEntryPoints, so a missing config costs the
 *  more specific failure notice rather than failing the request. */
export async function loadBridges(path: string): Promise<Set<string>> {
	try {
		return parseBridges(await readFile(path, 'utf8'));
	} catch (err) {
		log.warn('could not load bridge allowlist, cross-chain legs will read as NOT_DECODABLE', {
			module: 'settlementDecoders',
			path,
			error: err instanceof Error ? err.message : String(err),
		});
		return new Set();
	}
}

export interface EntryPointsConfig {
	_comment: string;
	chainId: number;
	entryPoints: string[];
}

export function parseEntryPoints(json: string): Set<string> {
	const parsed = JSON.parse(json) as Partial<EntryPointsConfig>;
	const out = new Set<string>();
	for (const a of parsed.entryPoints ?? []) out.add(a.toLowerCase());
	return out;
}

/** Load the EntryPoint allowlist; degrade to an empty set on any error (never
 *  throw) — matches loadReactors, so a missing config disables re-anchoring
 *  rather than failing the whole receipt. */
export async function loadEntryPoints(path: string): Promise<Set<string>> {
	try {
		return parseEntryPoints(await readFile(path, 'utf8'));
	} catch (err) {
		log.warn('could not load EntryPoint allowlist, ERC-4337 trades will not re-anchor', {
			module: 'settlementDecoders',
			path,
			error: err instanceof Error ? err.message : String(err),
		});
		return new Set();
	}
}

export interface ReactorsConfig {
	_comment: string;
	generatedAt: string;
	chainId: number;
	reactors: string[];
}

export function parseReactors(json: string): Set<string> {
	const parsed = JSON.parse(json) as Partial<ReactorsConfig>;
	const out = new Set<string>();
	for (const a of parsed.reactors ?? []) out.add(a.toLowerCase());
	return out;
}

/** Load the reactor allowlist; degrade to an empty set on any error (never throw). */
export async function loadReactors(path: string): Promise<Set<string>> {
	try {
		return parseReactors(await readFile(path, 'utf8'));
	} catch (err) {
		log.warn('could not load reactor allowlist, UniswapX trades will not re-anchor', {
			module: 'settlementDecoders',
			path,
			error: err instanceof Error ? err.message : String(err),
		});
		return new Set();
	}
}
