import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReceipts, type BuildReceiptsOptions } from './buildReceipts.js';
import { candidatesSelectSql, candidatesSetupSql, SWAP_TOPICS } from './candidatesSql.js';
import { LEG_COLUMNS, RECEIPT_COLUMNS } from './derivedSchema.js';
import { routerValuesSql } from './routerRegistry.js';
import type { SeedRow } from './schema.js';
import { copyQueryToParquet } from './writeParquet.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildReceipts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedRow(txHash: string, position: number, txTo: string): SeedRow {
	return {
		chain_id: 8453, block_number: 50842630 + position, block_position: position,
		tx_hash: txHash, block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom', tx_to: txTo, tx_status: true, block_hash: '0xblock',
		trace_json: JSON.stringify({ type: 'CALL', from: '0xa', to: '0xb', calls: [] }),
		receipt_json: JSON.stringify({
			blockNumber: '0x' + (50842630 + position).toString(16), gasUsed: '0x5208',
			effectiveGasPrice: '0x3b9aca00',
			// address must be valid hex — fromSeedJson (packages/core) validates it
			// unconditionally, even when `decode` below is a stub that never reads it.
			logs: [{ address: '0x000000000000000000000000000000000000aa', topics: [SWAP_TOPICS.v3], data: '0x' }],
		}),
		tx_json: JSON.stringify({ from: '0xfrom', to: txTo, value: '0x0' }),
		block_json: '{}', finality: 'finalized', ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test', schema_version: 1,
	} as SeedRow;
}

/** A Seed and a candidates file built from it, the same way the real pipeline does. */
async function fixtures(hashes: string[]) {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(hashes.map((h, i) => seedRow(h, i, ROUTER)), seedPath);
	const candidatesPath = join(dir, 'candidates.base.0050842630-0050842929.parquet');
	await copyQueryToParquet({
		outPath: candidatesPath,
		setupSql: candidatesSetupSql({
			seedGlob: seedPath,
			routerValues: routerValuesSql([{ address: ROUTER, name: '1inch', version: 'V5' }]),
		}),
		selectSql: candidatesSelectSql({
			seedFile: 'seed.parquet', derivedAt: '2026-09-08T12:00:00.000Z', schemaVersion: 2,
		}),
	});
	return { seedPath, candidatesPath };
}

const RECEIPT = {
	txHash: '0xa', chainId: 8453, blockNumber: 50842630,
	aggregator: '1inch', routerAddress: ROUTER, trader: '0xt', fillerAddress: null,
	direction: 'sell', inputToken: '0xin', outputToken: '0xout',
	inputSymbol: 'A', outputSymbol: 'B', inputAmount: 1, outputAmount: 2,
	notionalUsd: 100, realizedPrice: 2, marketMid: 2.1, marketMidBefore: null, marketMidAfter: null,
	allInCostBps: 47, pricingStatus: 'estimated', tier: 'estimated',
	methodology: 'Estimated: …', marketPriceFlags: [], referenceDepthUsd: null,
	referencePoolAddress: null, executionBps: 40, lpFeeBps: 5, aggFeeBps: 2,
	slippageBps: 0, gasCostUsd: 0.01, routePure: true, routeShape: 'single', hopCount: 1,
	routeLegs: [{
		venue: '0xpool', type: 'univ3', tokenIn: '0xin', tokenOut: '0xout',
		feeTierBps: 30, notionalUsdc: 100, notionalApprox: false, lpFeeBps: 5,
		priceImpactBps: 2, amountInRaw: '1000000000000000000', amountOutRaw: '2000000',
	}],
	routeReconstructed: true, reconResidualBps: 0, decompConfidence: 'high',
	feeRecipient: null, feeSinkSource: null, feeSinks: [],
	integratorFeeBps: null, fabricFeeBps: null, settlementEventName: null,
	settlementEventTopic0: null, settlementEventSeen: false, normalizeFlags: [],
	chainlinkPrice: null, chainlinkDevBps: null, poolDivergenceBps: null,
	manipulationFlag: false, offchainPrice: null, offchainDevBps: null,
	chainlinkStalenessSecs: null,
};

async function readParquet(path: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${path}')`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally { connection.closeSync(); instance.closeSync(); }
}

function opts(seedPath: string, candidatesPath: string, decode: BuildReceiptsOptions['decode']) {
	return {
		seedGlob: seedPath, seedFile: 'seed.parquet', candidatesGlob: candidatesPath,
		selectedVia: ['both'], dataDir: dir, build: 'testbuild', chain: 'base', chainId: 8453,
		fromBlock: 50842630, toBlock: 50842929, rpcUrl: 'http://stub',
		rpcSource: 'test-provider', coreGitSha: 'abc1234',
		now: () => new Date('2026-09-08T12:00:00.000Z'), decode,
	};
}

describe('buildReceipts', () => {
	it('writes both files with exactly the declared columns, in declared order', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		const r = await buildReceipts(opts(seedPath, candidatesPath, async () => RECEIPT));
		expect(Object.keys((await readParquet(r.receiptsPath))[0]!)).toEqual(Object.keys(RECEIPT_COLUMNS));
		expect(Object.keys((await readParquet(r.legsPath))[0]!)).toEqual(Object.keys(LEG_COLUMNS));
	});

	it('records a null decode as a failure ROW, never a skipped row', async () => {
		// ~36% of router candidates and ~60% of swap_log candidates decode to
		// null. Dropping them would make the table unable to state its own
		// coverage.
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath,
			async (hash) => (hash === '0xa' ? RECEIPT : null)));
		expect(r.attempted).toBe(2);
		expect(r.decoded).toBe(1);
		expect(r.failed).toBe(1);
		const rows = await readParquet(r.receiptsPath);
		expect(rows).toHaveLength(2);
		const failure = rows.find((x) => x.tx_hash === '0xb')!;
		expect(failure.failure_reason).not.toBeNull();
		expect(failure.price_confidence).toBe('Unavailable');
		expect(failure.all_in_cost_bps).toBeNull();
	});

	it('emits no leg rows for a failed decode, and joins legs to receipts on tx_hash', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath,
			async (hash) => (hash === '0xa' ? RECEIPT : null)));
		const legs = await readParquet(r.legsPath);
		expect(legs.map((l) => l.tx_hash)).toEqual(['0xa']);
		expect(Number(legs[0]!.leg_index)).toBe(0);
	});

	it('carries per-transaction block_position and block_timestamp from candidates', async () => {
		// These vary per row; a run-level constant here would stamp one
		// transaction's position onto another's receipt.
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath, async () => RECEIPT));
		const rows = await readParquet(r.receiptsPath);
		const positions = rows.map((x) => Number(x.block_position)).sort();
		expect(positions).toEqual([0, 1]);
	});

	it('honours the selectedVia filter', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		const r = await buildReceipts({
			...opts(seedPath, candidatesPath, async () => RECEIPT), selectedVia: ['router'],
		});
		// The fixture rows are router-called AND emit a Swap log, so they are
		// 'both'; filtering on 'router' alone must select none.
		expect(r.attempted).toBe(0);
	});

	it('honours limit', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb', '0xc']);
		const r = await buildReceipts({ ...opts(seedPath, candidatesPath, async () => RECEIPT), limit: 2 });
		expect(r.attempted).toBe(2);
	});

	it('passes prefetched, includeWings:false and a factCache to the decoder', async () => {
		// The three v0.2b-1 options are the whole reason this runner is cheap
		// and reproducible. A regression that silently stopped passing them
		// would cost an archive dependency and ~40% more RPC calls, with no
		// test failing anywhere else.
		const seen: Record<string, unknown>[] = [];
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		await buildReceipts(opts(seedPath, candidatesPath, async (_h, _c, o) => { seen.push(o); return RECEIPT; }));
		expect(seen).toHaveLength(1);
		expect(seen[0]!.includeWings).toBe(false);
		expect(seen[0]!.factCache).toBeDefined();
		expect(seen[0]!.prefetched).toBeDefined();
	});

	it('does not abort when every candidate fails and there are zero leg rows', async () => {
		// writeRowsToParquet refuses an empty row set. A run where every
		// candidate fails to decode must still finish and still publish its
		// receipts (all failure rows) rather than throwing because legs came
		// back empty.
		const { existsSync } = await import('node:fs');
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath, async () => null));
		expect(r.attempted).toBe(2);
		expect(r.decoded).toBe(0);
		expect(r.failed).toBe(2);
		expect(r.legRows).toBe(0);
		const rows = await readParquet(r.receiptsPath);
		expect(rows).toHaveLength(2);
		expect(rows.every((x) => x.failure_reason !== null)).toBe(true);
		// legsPath is still returned, but nothing was written there — an empty
		// Parquet file is never correct, so the write is skipped rather than
		// forced.
		expect(existsSync(r.legsPath)).toBe(false);
	});

	it('imports its runtime values from @fabric-tca/core/runtime, not @fabric-tca/core', async () => {
		// A value import from the default subpath resolves to src/index.ts and
		// dies under dist/ with ERR_UNKNOWN_FILE_EXTENSION.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./buildReceipts.ts', import.meta.url), 'utf8');
		expect(src.match(/import\s+(?!type\b)[\s\S]*?from\s*['"]@fabric-tca\/core['"]/g)).toBeNull();
	});
});
