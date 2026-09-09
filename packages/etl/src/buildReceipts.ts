import type { Receipt } from '@fabric-tca/core';
import {
	analyzeTransaction as realAnalyze,
	createMemoryFactCache,
	fromSeedJson,
} from '@fabric-tca/core/runtime';
import { derivedFilePath } from './derivedPath.js';
import { derivedColumnSpec, LEG_COLUMNS, RECEIPT_COLUMNS } from './derivedSchema.js';
import { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';
import { toFailureRow, toLegRows, toReceiptRow, type RunContext, type TxContext } from './receiptRows.js';
import { sqlLiteral } from './sql.js';
import { withDuckDb, writeRowsToParquet } from './writeParquet.js';

/**
 * buildReceipts.ts — the serial enrichment runner.
 *
 * ⚠️ SERIAL, ALWAYS. There is no concurrency option and there must never be
 * one. Determinism was measured at 535/535 identical over two serial passes,
 * and that guarantee is serial-only: under concurrent load the endpoint fails
 * reads transiently, the decoder swallows those as evidence (`catch → null`
 * means "no such pool"), and receipts come back quietly degraded.
 *
 * ⚠️ Runtime values come from '@fabric-tca/core/runtime', NOT
 * '@fabric-tca/core'. The default subpath resolves to src/index.ts, which node
 * cannot load from compiled code. Types may come from either.
 *
 * Payloads are fetched in chunks: trace_json averages ~17 KB and the full
 * candidate set is 13,511 rows, so joining every payload at once would hold
 * hundreds of MB for no reason. Output rows are small enough to accumulate.
 */

/** Seed payloads are fetched this many transactions at a time. */
const PAYLOAD_CHUNK = 100;

/** Injectable decode signature — loose enough that a test stub and the real
 *  `analyzeTransaction` (whose `opts` is the narrower `AnalyzeTransactionOptions`)
 *  both satisfy it. */
type Decoder = (hash: string, chainId: number, opts: Record<string, unknown>) => Promise<unknown>;

export interface BuildReceiptsOptions {
	/** Path or glob handed to `read_parquet`, for the Seed payloads. */
	seedGlob: string;
	/** Human label stamped into every row's `seed_file`. */
	seedFile: string;
	/** Path or glob handed to `read_parquet`, for the candidates work list. */
	candidatesGlob: string;
	/** `selected_via` values to include — e.g. `['router', 'swap_log', 'both']`. */
	selectedVia: string[];
	dataDir: string;
	build: string;
	chain: string;
	chainId: number;
	fromBlock: number;
	toBlock: number;
	rpcUrl: string;
	rpcSource: string;
	coreGitSha: string;
	limit?: number;
	onProgress?: (done: number, total: number) => void;
	/** Injected so `derived_at` is deterministic under test. */
	now?: () => Date;
	/** Injected so the runner is testable without a live endpoint. Defaults to
	 *  the real analyzeTransaction from '@fabric-tca/core/runtime'.
	 *
	 *  ⚠️ Explicitly `| undefined`, not just `?:` — `exactOptionalPropertyTypes`
	 *  requires it: the test's `opts()` helper passes this through a plain
	 *  parameter typed `BuildReceiptsOptions['decode']`, which is `T | undefined`
	 *  at a REQUIRED key, and that only satisfies an optional target property
	 *  whose own type includes `undefined` too. */
	decode?: ((hash: string, chainId: number, opts: Record<string, unknown>) => Promise<unknown>) | undefined;
}

export interface BuildReceiptsResult {
	receiptsPath: string;
	legsPath: string;
	attempted: number;
	decoded: number;
	failed: number;
	legRows: number;
}

interface WorkItem {
	txHash: string;
	chainId: number;
	blockNumber: number;
	blockPosition: number;
	blockTimestamp: string;
}

interface SeedPayload {
	receiptJson: string;
	txJson: string;
	traceJson: string;
}

/** The work list: one row per candidate matching `selectedVia` AND `chainId`,
 *  ordered so the run's progress and the written files both come out in block
 *  order.
 *
 *  ⚠️ The `chain_id` filter is load-bearing, not decorative. `--chain` picks
 *  the FILE (which candidates/Seed glob to read), but a glob can be pointed at
 *  the wrong chain's data by a typo, and without this filter every row in it
 *  gets decoded and labelled with whatever `--chain-id` the caller passed —
 *  writing mainnet-labelled facts into `pools.base.parquet` with no error. The
 *  `FactCache` is chain-keyed AND persistent, so a mislabelled fact outlives
 *  the run that made it and is trusted by every later correct run. */
async function loadWorkList(opts: {
	candidatesGlob: string;
	selectedVia: string[];
	chainId: number;
	limit?: number;
}): Promise<WorkItem[]> {
	return withDuckDb(async (connection) => {
		const viaList = opts.selectedVia.map(sqlLiteral).join(', ');
		const limitSql = opts.limit === undefined ? '' : `LIMIT ${opts.limit}`;
		const reader = await connection.runAndReadAll(
			`SELECT tx_hash, chain_id, block_number, block_position, epoch_ms(block_timestamp) AS block_timestamp_ms
			 FROM read_parquet(${sqlLiteral(opts.candidatesGlob)})
			 WHERE selected_via IN (${viaList})
			   AND chain_id = ${opts.chainId}
			 ORDER BY block_number, block_position
			 ${limitSql}`,
		);
		const rows = reader.getRowObjects() as Record<string, unknown>[];
		return rows.map((row) => ({
			txHash: String(row.tx_hash),
			chainId: Number(row.chain_id),
			blockNumber: Number(row.block_number as unknown as bigint),
			blockPosition: Number(row.block_position),
			blockTimestamp: new Date(Number(row.block_timestamp_ms as unknown as bigint)).toISOString(),
		}));
	});
}

/** Seed payloads for one chunk of transaction hashes, keyed by `tx_hash`. */
async function loadSeedPayloads(seedGlob: string, hashes: readonly string[]): Promise<Map<string, SeedPayload>> {
	return withDuckDb(async (connection) => {
		const hashList = hashes.map(sqlLiteral).join(', ');
		const reader = await connection.runAndReadAll(
			`SELECT tx_hash, receipt_json, tx_json, trace_json
			 FROM read_parquet(${sqlLiteral(seedGlob)})
			 WHERE tx_hash IN (${hashList})`,
		);
		const rows = reader.getRowObjects() as Record<string, unknown>[];
		const byHash = new Map<string, SeedPayload>();
		for (const row of rows) {
			byHash.set(String(row.tx_hash), {
				receiptJson: String(row.receipt_json),
				txJson: String(row.tx_json),
				traceJson: String(row.trace_json),
			});
		}
		return byHash;
	});
}

export async function buildReceipts(opts: BuildReceiptsOptions): Promise<BuildReceiptsResult> {
	const receiptsPath = derivedFilePath({
		dataDir: opts.dataDir, build: opts.build, family: 'receipts',
		chain: opts.chain, fromBlock: opts.fromBlock, toBlock: opts.toBlock,
	});
	const legsPath = derivedFilePath({
		dataDir: opts.dataDir, build: opts.build, family: 'legs',
		chain: opts.chain, fromBlock: opts.fromBlock, toBlock: opts.toBlock,
	});

	// One FactCache for the whole run, loaded from disk once and saved once at
	// the end — that is where the RPC savings compound. Because the memory
	// cache is SEEDED with what was already on disk and never rebuilt, calling
	// `.entries()` at the end returns loaded facts plus everything the run
	// added, with no separate merge step.
	const factCache = createMemoryFactCache(await loadFactCacheEntries({ dataDir: opts.dataDir, chain: opts.chain }));

	const workList = await loadWorkList({
		candidatesGlob: opts.candidatesGlob,
		selectedVia: opts.selectedVia,
		chainId: opts.chainId,
		...(opts.limit === undefined ? {} : { limit: opts.limit }),
	});
	const total = workList.length;

	const decodeFn: Decoder = opts.decode ?? (realAnalyze as unknown as Decoder);
	const run: RunContext = {
		coreGitSha: opts.coreGitSha,
		rpcSource: opts.rpcSource,
		seedFile: opts.seedFile,
		derivedAt: (opts.now?.() ?? new Date()).toISOString(),
	};

	const receiptRows: ReturnType<typeof toReceiptRow>[] = [];
	const legRows: ReturnType<typeof toLegRows>[number][] = [];
	let attempted = 0;
	let decoded = 0;
	let failed = 0;

	for (let start = 0; start < workList.length; start += PAYLOAD_CHUNK) {
		const chunk = workList.slice(start, start + PAYLOAD_CHUNK);
		const payloads = await loadSeedPayloads(opts.seedGlob, chunk.map((item) => item.txHash));

		for (const item of chunk) {
			attempted += 1;
			const tx: TxContext = { blockPosition: item.blockPosition, blockTimestamp: item.blockTimestamp };
			const payload = payloads.get(item.txHash);

			let receipt: Receipt | null = null;
			let failureReason: string | null = null;

			if (!payload) {
				failureReason = `No Seed payload found for ${item.txHash} in ${opts.seedGlob}`;
			} else {
				// ⚠️ analyzeTransaction is documented never to throw, but a throw
				// here must become a failure row, not lose the run's accumulated
				// work — everything decoded before this transaction is still good.
				try {
					const prefetched = fromSeedJson({
						receiptJson: payload.receiptJson,
						txJson: payload.txJson,
						traceJson: payload.traceJson,
					});
					const result = await decodeFn(item.txHash, item.chainId, {
						rpcUrl: opts.rpcUrl,
						prefetched,
						includeWings: false,
						factCache,
					});
					if (result == null) {
						failureReason = 'analyzeTransaction returned null (not a clean two-token swap)';
					} else {
						receipt = result as Receipt;
					}
				} catch (err) {
					failureReason = `decode threw: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			if (receipt) {
				decoded += 1;
				receiptRows.push(toReceiptRow(receipt, tx, run));
				legRows.push(...toLegRows(receipt));
			} else {
				failed += 1;
				receiptRows.push(
					toFailureRow(
						{
							txHash: item.txHash,
							chainId: item.chainId,
							blockNumber: item.blockNumber,
							failureReason: failureReason ?? 'decode produced no receipt',
						},
						tx,
						run,
					),
				);
			}

			opts.onProgress?.(attempted, total);
		}
	}

	// writeRowsToParquet refuses an empty row set — an empty file is never
	// correct. A run whose candidates all failed (or whose selectedVia/limit
	// filtered the work list down to nothing) produces zero rows for one or
	// both families; skip that write rather than aborting the run, and still
	// return the path the family WOULD live at.
	if (receiptRows.length > 0) {
		// block_number, block_position — NOT tx_hash. writeParquet.ts's docstring
		// explains why: row-group min/max statistics only prune a block-range
		// filter when the rows are ordered by the column being filtered on.
		// Measured on the shipped file before this fix: all four row groups
		// reported the SAME block_number min/max (the full range) because
		// tx_hash order scrambles block order — pruning was worth nothing.
		await writeRowsToParquet(receiptRows, {
			outPath: receiptsPath,
			columnSpec: derivedColumnSpec(RECEIPT_COLUMNS),
			orderBy: 'block_number, block_position',
		});
	}
	if (legRows.length > 0) {
		// tx_hash, leg_index — JOIN-KEY ordered, not prune-ordered. legs has no
		// block column to prune on; its access pattern is "join to receipts on
		// tx_hash, then walk legs in route order", so this ordering serves that
		// instead. The asymmetry with receipts' block-ordered write above is
		// deliberate, not an oversight.
		await writeRowsToParquet(legRows, {
			outPath: legsPath,
			columnSpec: derivedColumnSpec(LEG_COLUMNS),
			orderBy: 'tx_hash, leg_index',
		});
	}

	await saveFactCacheEntries(factCache.entries(), { dataDir: opts.dataDir, chain: opts.chain });

	return { receiptsPath, legsPath, attempted, decoded, failed, legRows: legRows.length };
}
