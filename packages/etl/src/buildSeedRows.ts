import { SCHEMA_VERSION, type Finality, type SeedRow } from './schema.js';
import type { RawBlock, RawReceipt, RawTx, TraceEntry } from './rpcTypes.js';

/**
 * buildSeedRows.ts — the pure core of the Seed layer.
 *
 * Three RPC responses describe the same block in three independent orderings.
 * This module joins them into one row per transaction and does NOTHING else:
 * no decoding, no classification, no arithmetic. Every value it writes is
 * either copied verbatim from a payload or is provenance supplied by the
 * caller.
 *
 * The assembly is keyed on TRANSACTION HASH, never on array index. A row that
 * paired one transaction's trace with another's receipt would be undetectable
 * downstream and trusted completely, so a disagreement between the payloads
 * aborts the whole block rather than emitting a plausible-looking row. That
 * standard extends past "does every hash resolve": equal array lengths plus
 * full membership only imply the same SET of hashes if none of the three
 * payloads contains a duplicate, so duplicates are checked explicitly; the
 * three payloads must also agree they describe the SAME block (blockHash +
 * blockNumber), not just the same transaction count, since a reorg between
 * RPC round-trips can hand back three internally-consistent payloads for
 * different blocks; and every promoted, load-bearing column (block_position
 * chief among them) is validated rather than trusted to parse cleanly.
 */

export interface BlockPayloads {
	traceBlock: TraceEntry[];
	receipts: RawReceipt[];
	block: RawBlock;
}

export interface IngestMeta {
	chainId: number;
	finality: Finality;
	/** ISO 8601 UTC. */
	ingestedAt: string;
	/** Provider label, never a URL — TCA_RPC_URL carries an API key. */
	source: string;
}

/**
 * Lowercase a promoted string column, naming the field if it is not a string.
 *
 * Every hash and address column goes through here, and a payload missing one
 * of them used to surface as `Cannot read properties of undefined (reading
 * 'toLowerCase')` — a message that names neither the field nor the block, so
 * an operator staring at an aborted ingest has nothing to go on. The abort
 * itself was always correct; only the diagnosis was missing.
 */
const lower = (value: unknown, field: string): string => {
	if (typeof value !== 'string') {
		throw new Error(`Expected a string for ${field}, got ${JSON.stringify(value)}`);
	}
	return value.toLowerCase();
};

/**
 * `receipt.status` → `tx_status`, the Seed's one boolean PRUNING column:
 * downstream queries filter on it, so a wrong value is silently load-bearing
 * in an immutable file. It used to be `receipt.status === '0x1'`, which turns
 * every value that is not exactly that four-character string — a missing
 * field, or the zero-padded `'0x01'` some clients emit — into `false`, i.e.
 * marks every transaction in the archive as REVERTED, permanently and without
 * an error. Accept `0x0`/`0x1` case- and pad-insensitively; refuse anything
 * else rather than guess.
 */
function parseTxStatus(status: unknown, field: string): boolean {
	if (typeof status === 'string') {
		const normalized = status.toLowerCase();
		if (/^0x0*1$/.test(normalized)) return true;
		if (/^0x0*0$/.test(normalized)) return false;
	}
	throw new Error(
		`Expected receipt.status to be 0x1 or 0x0 for ${field}, got ${JSON.stringify(status)}`,
	);
}

/**
 * Hex quantity → number. Used only for values known to be small (index,
 * block, timestamp). `Number.parseInt` returns `NaN` rather than throwing on
 * a malformed or missing input, and `NaN` would otherwise flow silently into
 * a `block_position`/`block_number` column and serialize as JSON `null` — so
 * this rejects a non-finite result itself, naming the field and the raw
 * value that produced it.
 */
function hexToNumber(hex: string, field: string): number {
	const n = Number.parseInt(hex, 16);
	if (!Number.isFinite(n)) {
		throw new Error(`Expected a hex quantity for ${field}, got ${JSON.stringify(hex)}`);
	}
	return n;
}

export function buildSeedRows(payloads: BlockPayloads, meta: IngestMeta): SeedRow[] {
	const { traceBlock, receipts, block } = payloads;
	const txs = block.transactions;

	if (traceBlock.length !== receipts.length || traceBlock.length !== txs.length) {
		throw new Error(
			`Payloads disagree on transaction count for block ${block.number}: ` +
				`trace=${traceBlock.length} receipts=${receipts.length} txs=${txs.length}`,
		);
	}

	// Equal lengths only imply the same SET of hashes across all three
	// payloads if none of them repeats a hash internally. Check that first —
	// a duplicate hash paired with a length-only check lets one real
	// transaction silently vanish while another is emitted twice.
	const receiptByHash = new Map<string, RawReceipt>(
		receipts.map((r) => [lower(r.transactionHash, 'receipt.transactionHash'), r]),
	);
	if (receiptByHash.size !== receipts.length) {
		throw new Error(`Duplicate transactionHash among receipts in block ${block.number}`);
	}
	const txByHash = new Map<string, RawTx>(txs.map((t) => [lower(t.hash, 'tx.hash'), t]));
	if (txByHash.size !== txs.length) {
		throw new Error(`Duplicate hash among transactions in block ${block.number}`);
	}
	const traceHashSet = new Set(traceBlock.map((e) => lower(e.txHash, 'trace.txHash')));
	if (traceHashSet.size !== traceBlock.length) {
		throw new Error(`Duplicate txHash among trace entries in block ${block.number}`);
	}

	// The header travels on every row so a single row is self-sufficient. Its
	// `transactions` key is dropped because those transactions ARE the rows.
	// This and the trace-entry unwrap below (`entry.result`, not `entry`
	// itself, becomes `trace_json`) are the only two field-level
	// transformations anywhere in the Seed layer — both are lossless because
	// the dropped wrapper key (`transactions`, `txHash`) is already promoted
	// to its own column elsewhere on the row.
	const { transactions: _dropped, ...header } = block;
	const blockJson = JSON.stringify(header);
	const blockHash = lower(block.hash, 'block.hash');
	const blockNumber = hexToNumber(block.number, 'block.number');
	const blockTimestamp = new Date(
		hexToNumber(block.timestamp, 'block.timestamp') * 1000,
	).toISOString();

	// The three payloads must describe the SAME block, not merely agree on
	// transaction count and hashes. Three independently-fetched RPC responses
	// spanning a reorg could each be internally consistent and still describe
	// different blocks; every receipt and tx carries its own blockHash and
	// blockNumber, so check them against the block header rather than assume.
	for (const r of receipts) {
		const rHash = lower(r.transactionHash, 'receipt.transactionHash');
		const rBlockHash = lower(r.blockHash, `receipt.blockHash for ${rHash}`);
		if (rBlockHash !== blockHash) {
			throw new Error(
				`Receipt ${rHash} blockHash ${rBlockHash} does not match block ` +
					`${block.number}'s hash ${blockHash} — payloads may span a reorg`,
			);
		}
		const rBlockNumber = hexToNumber(r.blockNumber, `receipt.blockNumber for ${rHash}`);
		if (rBlockNumber !== blockNumber) {
			throw new Error(
				`Receipt ${rHash} blockNumber ${rBlockNumber} does not match block ` +
					`${blockNumber} — payloads may span a reorg`,
			);
		}
	}
	for (const t of txs) {
		const tHash = lower(t.hash, 'tx.hash');
		const tBlockHash = lower(t.blockHash, `tx.blockHash for ${tHash}`);
		if (tBlockHash !== blockHash) {
			throw new Error(
				`Transaction ${tHash} blockHash ${tBlockHash} does not match block ` +
					`${block.number}'s hash ${blockHash} — payloads may span a reorg`,
			);
		}
		const tBlockNumber = hexToNumber(t.blockNumber, `tx.blockNumber for ${tHash}`);
		if (tBlockNumber !== blockNumber) {
			throw new Error(
				`Transaction ${tHash} blockNumber ${tBlockNumber} does not match block ` +
					`${blockNumber} — payloads may span a reorg`,
			);
		}
	}

	const rows: SeedRow[] = [];
	const seenPositions = new Set<number>();
	for (const entry of traceBlock) {
		const hash = lower(entry.txHash, 'trace.txHash');
		const receipt = receiptByHash.get(hash);
		if (!receipt) throw new Error(`Trace for ${hash} has no receipt in block ${block.number}`);
		const tx = txByHash.get(hash);
		if (!tx) throw new Error(`Trace for ${hash} has no transaction in block ${block.number}`);
		// `== null` on purpose: a trace entry whose `result` is explicitly null
		// would otherwise serialize as the four-character string "null", which is
		// indistinguishable downstream from a genuine null trace — absent read as
		// measured, in a file that can never be rewritten.
		if (entry.result == null) {
			throw new Error(`Trace for ${hash} has no result in block ${block.number}`);
		}

		// block_position is a promoted, load-bearing ordering column. Read it
		// from the receipt, but cross-check it against the tx envelope's own
		// transactionIndex (a second, independent source for the same fact)
		// and reject a collision with a position already assigned this block —
		// both are free correctness checks the payloads already carry.
		const receiptPosition = hexToNumber(
			receipt.transactionIndex,
			`receipt.transactionIndex for ${hash}`,
		);
		const txPosition = hexToNumber(tx.transactionIndex, `tx.transactionIndex for ${hash}`);
		if (receiptPosition !== txPosition) {
			throw new Error(
				`receipt.transactionIndex (${receiptPosition}) disagrees with tx.transactionIndex ` +
					`(${txPosition}) for ${hash} in block ${block.number}`,
			);
		}
		if (seenPositions.has(receiptPosition)) {
			throw new Error(`Duplicate block_position ${receiptPosition} in block ${block.number}`);
		}
		seenPositions.add(receiptPosition);

		rows.push({
			chain_id: meta.chainId,
			block_number: blockNumber,
			block_position: receiptPosition,
			tx_hash: hash,
			block_timestamp: blockTimestamp,
			tx_from: lower(receipt.from, `receipt.from for ${hash}`),
			// Explicit null check: `receipt.to ? … : null` would coerce an
			// empty string to null too, silently mistaking it for a
			// contract-creation transaction.
			tx_to: receipt.to === null ? null : lower(receipt.to, `receipt.to for ${hash}`),
			tx_status: parseTxStatus(receipt.status, hash),
			block_hash: blockHash,
			trace_json: JSON.stringify(entry.result),
			receipt_json: JSON.stringify(receipt),
			tx_json: JSON.stringify(tx),
			block_json: blockJson,
			finality: meta.finality,
			ingested_at: meta.ingestedAt,
			source: meta.source,
			schema_version: SCHEMA_VERSION,
		});
	}

	rows.sort((a, b) => a.block_position - b.block_position);
	return rows;
}
