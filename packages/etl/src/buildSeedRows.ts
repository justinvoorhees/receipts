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
 * aborts the whole block rather than emitting a plausible-looking row.
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

const lower = (value: string): string => value.toLowerCase();

/** Hex quantity → number. Used only for values known to be small (index, block, timestamp). */
function hexToNumber(hex: string): number {
	return Number.parseInt(hex, 16);
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

	const receiptByHash = new Map<string, RawReceipt>(
		receipts.map((r) => [lower(r.transactionHash), r]),
	);
	const txByHash = new Map<string, RawTx>(txs.map((t) => [lower(t.hash), t]));

	// The header travels on every row so a single row is self-sufficient. Its
	// `transactions` key is dropped because those transactions ARE the rows —
	// this is the only field-level transformation anywhere in the Seed layer.
	const { transactions: _dropped, ...header } = block;
	const blockJson = JSON.stringify(header);
	const blockHash = lower(block.hash);
	const blockNumber = hexToNumber(block.number);
	const blockTimestamp = new Date(hexToNumber(block.timestamp) * 1000).toISOString();

	const rows: SeedRow[] = [];
	for (const entry of traceBlock) {
		const hash = lower(entry.txHash);
		const receipt = receiptByHash.get(hash);
		if (!receipt) throw new Error(`Trace for ${hash} has no receipt in block ${block.number}`);
		const tx = txByHash.get(hash);
		if (!tx) throw new Error(`Trace for ${hash} has no transaction in block ${block.number}`);

		rows.push({
			chain_id: meta.chainId,
			block_number: blockNumber,
			block_position: hexToNumber(receipt.transactionIndex),
			tx_hash: hash,
			block_timestamp: blockTimestamp,
			tx_from: lower(receipt.from),
			tx_to: receipt.to ? lower(receipt.to) : null,
			tx_status: receipt.status === '0x1',
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
