import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCandidates } from './buildCandidates.js';
import { CANDIDATE_COLUMNS } from './derivedSchema.js';
import { SWAP_TOPICS } from './candidatesSql.js';
import type { SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'buildCandidates-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seedRow(txHash: string, position: number, logs: unknown[], txTo = '0xdead'): SeedRow {
	return {
		chain_id: 8453,
		block_number: 50842630 + position,
		block_position: position,
		tx_hash: txHash,
		block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom',
		tx_to: txTo,
		tx_status: true,
		block_hash: '0xblock',
		trace_json: '{}',
		receipt_json: JSON.stringify({ logs, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }),
		tx_json: JSON.stringify({ value: '0x0' }),
		block_json: '{}',
		finality: 'finalized',
		ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test',
		schema_version: 1,
	} as SeedRow;
}

async function setup(): Promise<{ seedPath: string; routersPath: string }> {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(
		[
			seedRow('0xa', 0, [{ address: '0xpool1', topics: [SWAP_TOPICS.v3], data: '0x' }]),
			seedRow('0xb', 1, [], ROUTER),
			seedRow('0xc', 2, [{ address: '0xtoken', topics: ['0xother'], data: '0x' }]),
		],
		seedPath,
	);
	const routersPath = join(dir, 'routers.json');
	writeFileSync(
		routersPath,
		JSON.stringify({ routers: [{ name: '1inch', address: ROUTER, version: 'V5', active: true }] }),
	);
	return { seedPath, routersPath };
}

describe('buildCandidates', () => {
	it('writes a candidates file at the derived path and excludes non-candidates', async () => {
		const { seedPath, routersPath } = await setup();
		const result = await buildCandidates({
			seedGlob: seedPath,
			seedFile: 'traces.base.0050842630-0050842929.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		});

		expect(result.rowCount).toBe(2); // 0xc is neither a router call nor a swap
		expect(result.outPath).toBe(
			join(dir, 'derived', 'testbuild', 'candidates.base.0050842630-0050842929.parquet'),
		);
		expect(existsSync(result.outPath)).toBe(true);
	});

	it('writes exactly the declared columns, in declared order', async () => {
		const { seedPath, routersPath } = await setup();
		const result = await buildCandidates({
			seedGlob: seedPath,
			seedFile: 'seed.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		});

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		try {
			const reader = await connection.runAndReadAll(
				`SELECT * FROM read_parquet('${result.outPath}') LIMIT 1`,
			);
			expect(reader.columnNames()).toEqual(Object.keys(CANDIDATE_COLUMNS));
		} finally {
			connection.closeSync();
			instance.closeSync();
		}
	});

	it('is idempotent: a second build replaces the file at the same path', async () => {
		const { seedPath, routersPath } = await setup();
		const opts = {
			seedGlob: seedPath,
			seedFile: 'seed.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		};
		const first = await buildCandidates(opts);
		const second = await buildCandidates(opts);
		expect(second.outPath).toBe(first.outPath);
		expect(second.rowCount).toBe(first.rowCount);
	});
});
