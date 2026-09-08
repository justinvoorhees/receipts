/**
 * prefetched.ts — Seed JSON in, the shapes analyzeTransaction expects out.
 *
 * The ETL Seed layer already holds every transaction's receipt, envelope and
 * callTracer trace as raw RPC JSON. Feeding those straight to the decoder saves
 * only 3 of ~175 RPC calls, but it removes the archive-node dependency for that
 * step and makes a derived build reproducible from disk.
 *
 * ⚠️ THE FIELD LIST BELOW IS THE CONTRACT. The decoder touches a small,
 * enumerable slice of viem's TransactionReceipt and Transaction:
 *
 *   receipt.logs[].address, receipt.logs[].topics, receipt.blockNumber,
 *   receipt.gasUsed, receipt.effectiveGasPrice, tx.from, tx.to
 *
 * These types are deliberately narrow rather than viem's full ones, so that a
 * decoder change reaching for an eighth field fails to COMPILE here instead of
 * reading `undefined` at runtime.
 *
 * Casing is NOT normalized: every consumer lowercases at its own call site, and
 * normalizing early would make prefetched input differ from live input.
 */

export interface PrefetchedLog {
	address: string;
	topics: string[];
}

export interface PrefetchedReceipt {
	logs: PrefetchedLog[];
	blockNumber: bigint;
	gasUsed: bigint;
	/** Absent on some chains/clients. MUST stay undefined rather than 0n — the
	 *  gas-cost math multiplies by it, and 0n reports a free transaction. */
	effectiveGasPrice?: bigint;
}

export interface PrefetchedTransaction {
	from: string;
	/** NULL for a contract creation. */
	to: string | null;
}

export interface PrefetchedTx {
	receipt: PrefetchedReceipt;
	tx: PrefetchedTransaction;
	/** Passed through to the decoder as a TraceNode with no transformation. */
	trace: unknown;
}

function parseJson(text: string, what: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Prefetched ${what} is not valid JSON: ${(err as Error).message}`);
	}
}

/** Required hex quantity → bigint. Throws rather than yielding NaN or 0n. */
function requiredHex(value: unknown, field: string): bigint {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
		throw new Error(`Prefetched receipt has no usable ${field} (got ${JSON.stringify(value)})`);
	}
	return BigInt(value);
}

function optionalHex(value: unknown): bigint | undefined {
	return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : undefined;
}

/** Required 0x-prefixed string field (address or topic) → the string itself,
 *  unmodified (no BigInt conversion — addresses/topics stay strings). Throws
 *  rather than silently coercing a missing value to the literal "undefined",
 *  which — fed to `resolveTrader`'s REACTORS/ENTRY_POINTS match — would
 *  produce a DIFFERENT receipt with a different trader anchor, not a null one. */
function requiredHexString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
		throw new Error(`Prefetched log has no usable ${field} (got ${JSON.stringify(value)})`);
	}
	return value;
}

export function fromSeedJson(args: {
	receiptJson: string;
	txJson: string;
	traceJson: string;
}): PrefetchedTx {
	const receipt = parseJson(args.receiptJson, 'receipt');
	const tx = parseJson(args.txJson, 'transaction');
	const trace = parseJson(args.traceJson, 'trace');

	if (!Array.isArray(receipt.logs)) {
		throw new Error(`Prefetched receipt has no usable logs (got ${JSON.stringify(receipt.logs)})`);
	}
	const rawLogs = receipt.logs as Record<string, unknown>[];
	const logs: PrefetchedLog[] = rawLogs.map((l, i) => {
		if (!Array.isArray(l.topics)) {
			throw new Error(`Prefetched log has no usable logs[${i}].topics (got ${JSON.stringify(l.topics)})`);
		}
		return {
			address: requiredHexString(l.address, `logs[${i}].address`),
			topics: (l.topics as unknown[]).map((t, j) => requiredHexString(t, `logs[${i}].topics[${j}]`)),
		};
	});

	const effectiveGasPrice = optionalHex(receipt.effectiveGasPrice);

	return {
		receipt: {
			logs,
			blockNumber: requiredHex(receipt.blockNumber, 'blockNumber'),
			gasUsed: requiredHex(receipt.gasUsed, 'gasUsed'),
			...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }),
		},
		tx: {
			from: String(tx.from),
			to: typeof tx.to === 'string' ? tx.to : null,
		},
		trace,
	};
}
