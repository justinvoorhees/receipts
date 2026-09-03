/**
 * rpcTypes.ts — the shapes of the three raw RPC payloads, as returned.
 *
 * These are deliberately LOOSE. Only the fields this package actually promotes
 * to a column are named; everything else rides along in an index signature and
 * reaches Parquet untouched inside a JSON payload. Naming a field here would
 * imply we understand it, and understanding is a Derived-file concern.
 */

export interface TraceEntry {
	txHash: string;
	result: unknown;
}

export interface RawReceipt {
	transactionHash: string;
	transactionIndex: string;
	from: string;
	to: string | null;
	status: string;
	[key: string]: unknown;
}

export interface RawTx {
	hash: string;
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
