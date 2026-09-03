/**
 * rpcTypes.ts — the shapes of the three raw RPC payloads, as returned.
 *
 * These are deliberately LOOSE. Only the fields this package actually promotes
 * to a column, or reads to VALIDATE that the three payloads agree, are named;
 * everything else rides along in an index signature and reaches Parquet
 * untouched inside a JSON payload. Naming a field here would imply we
 * understand it, and understanding is a Derived-file concern — but a
 * cross-payload consistency check is still assembly, not understanding.
 */

export interface TraceEntry {
	txHash: string;
	result: unknown;
}

export interface RawReceipt {
	transactionHash: string;
	transactionIndex: string;
	blockHash: string;
	blockNumber: string;
	from: string;
	to: string | null;
	status: string;
	[key: string]: unknown;
}

export interface RawTx {
	hash: string;
	transactionIndex: string;
	blockHash: string;
	blockNumber: string;
	from: string;
	to?: string | null;
	[key: string]: unknown;
}

export interface RawBlock {
	number: string;
	hash: string;
	timestamp: string;
	transactions: RawTx[];
	[key: string]: unknown;
}
