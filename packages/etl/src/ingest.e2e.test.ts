import { config } from 'dotenv';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { finalizedWindow, ingestRange } from './ingest.js';

config();
const RPC = process.env.TCA_RPC_URL;

const dir = mkdtempSync(join(tmpdir(), 'etl-e2e-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Live pipeline test against Base. Skips SILENTLY without TCA_RPC_URL, which is
 * the repo's established pattern — and its established trap. If you changed
 * ingest and this "passed", check that it actually RAN.
 */
describe.skipIf(!RPC)('ingestRange (live)', () => {
	it('ingests a small finalized range into the canonical archive', async () => {
		const { toBlock } = await finalizedWindow(RPC!, 1);
		const result = await ingestRange({
			rpcUrl: RPC!,
			chain: 'base',
			chainId: 8453,
			fromBlock: toBlock - 2,
			toBlock,
			dataDir: dir,
			source: 'quicknode-base-mainnet',
			allowUnfinalized: false,
			concurrency: 3,
		});

		expect(result.finality).toBe('finalized');
		expect(result.rowCount).toBeGreaterThan(0);
		// The canonical archive is a NON-recursive glob, so a finalized file must
		// land directly in seeds/, not in seeds/provisional/.
		expect(result.outPath).toContain(join('seeds', 'traces.base.'));
		expect(result.outPath).not.toContain('provisional');

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		const reader = await connection.runAndReadAll(
			`SELECT count(*) AS rows,
			        count(DISTINCT block_number) AS blocks,
			        count(DISTINCT finality) AS finalities,
			        min(finality) AS finality,
			        sum(CASE WHEN json_valid(trace_json)
			                  AND json_valid(receipt_json)
			                  AND json_valid(tx_json)
			                  AND json_valid(block_json) THEN 0 ELSE 1 END) AS bad_json
			   FROM read_parquet('${join(dir, 'seeds', '*.parquet')}')`,
		);
		const [row] = reader.getRowObjectsJS() as Record<string, unknown>[];
		expect(Number(row!.rows)).toBe(result.rowCount);
		expect(Number(row!.blocks)).toBe(3);
		expect(Number(row!.bad_json)).toBe(0);
		expect(row!.finality).toBe('finalized');
	}, 120_000);

	it('never emits a row whose payloads disagree about the transaction', async () => {
		const { toBlock } = await finalizedWindow(RPC!, 1);
		const result = await ingestRange({
			rpcUrl: RPC!,
			chain: 'base',
			chainId: 8453,
			fromBlock: toBlock,
			toBlock,
			dataDir: join(dir, 'align'),
			source: 'quicknode-base-mainnet',
			allowUnfinalized: false,
			concurrency: 1,
		});

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		const reader = await connection.runAndReadAll(
			`SELECT count(*) AS mismatched FROM read_parquet('${result.outPath}')
			  WHERE lower(json_extract_string(receipt_json, '$.transactionHash')) <> tx_hash
			     OR lower(json_extract_string(tx_json, '$.hash')) <> tx_hash`,
		);
		const [row] = reader.getRowObjectsJS() as Record<string, unknown>[];
		expect(Number(row!.mismatched)).toBe(0);
	}, 120_000);
});
