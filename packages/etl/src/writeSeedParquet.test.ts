import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const dir = mkdtempSync(join(tmpdir(), 'etl-parquet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const row = (position: number, overrides: Partial<SeedRow> = {}): SeedRow => ({
	chain_id: 8453,
	block_number: 50795977,
	block_position: position,
	tx_hash: `0x${String(position).padStart(64, '0')}`,
	block_timestamp: '2026-09-02T10:00:00.000Z',
	tx_from: '0xf1',
	tx_to: '0xd4',
	tx_status: true,
	block_hash: '0xbb',
	trace_json: '{"from":"0xf1","calls":[{"to":"0xc2"}]}',
	receipt_json: '{"status":"0x1"}',
	tx_json: '{"nonce":"0x1"}',
	block_json: '{"baseFeePerGas":"0x7"}',
	finality: 'finalized',
	ingested_at: '2026-09-03T01:02:03.000Z',
	source: 'quicknode-base-mainnet',
	schema_version: SCHEMA_VERSION,
	...overrides,
});

async function read(path: string, sql: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	const reader = await connection.runAndReadAll(sql.replace('$PATH', path));
	return reader.getRowObjectsJS() as Record<string, unknown>[];
}

describe('writeSeedParquet', () => {
	it('writes a DuckDB-readable Parquet with the exact 17 columns in order', async () => {
		const path = join(dir, 'cols.parquet');
		await writeSeedParquet([row(0)], path);
		const rows = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(Object.keys(rows[0]!)).toEqual([
			'chain_id', 'block_number', 'block_position', 'tx_hash', 'block_timestamp',
			'tx_from', 'tx_to', 'tx_status', 'block_hash', 'trace_json', 'receipt_json',
			'tx_json', 'block_json', 'finality', 'ingested_at', 'source', 'schema_version',
		]);
	});

	it('round-trips every column with the right JS type', async () => {
		const path = join(dir, 'types.parquet');
		await writeSeedParquet([row(0)], path);
		const [out] = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(out!.chain_id).toBe(8453);
		expect(out!.block_number).toBe(50795977n); // BIGINT reads back as bigint
		expect(out!.block_position).toBe(0);
		expect(out!.tx_status).toBe(true);
		expect(out!.block_timestamp).toBeInstanceOf(Date);
		expect((out!.block_timestamp as Date).toISOString()).toBe('2026-09-02T10:00:00.000Z');
		expect(out!.source).toBe('quicknode-base-mainnet');
		expect(out!.schema_version).toBe(1);
	});

	it('preserves a NULL tx_to rather than coercing it to a string', async () => {
		const path = join(dir, 'null.parquet');
		await writeSeedParquet([row(0, { tx_to: null })], path);
		const [out] = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(out!.tx_to).toBeNull();
	});

	it('leaves the JSON payloads queryable as nested JSON', async () => {
		const path = join(dir, 'json.parquet');
		await writeSeedParquet([row(0)], path);
		const [out] = await read(
			path,
			`SELECT json_extract_string(trace_json, '$.calls[0].to') AS nested FROM read_parquet('$PATH')`,
		);
		expect(out!.nested).toBe('0xc2');
	});

	it('sorts rows by (block_number, block_position) regardless of input order', async () => {
		const path = join(dir, 'sorted.parquet');
		// block_position values (20, 21, 22) are already ascending, so an
		// ORDER BY with the columns swapped — (block_position, block_number) —
		// would reproduce this exact physical order too, since block_position
		// alone already fully determines it. block_number is scrambled
		// independently of block_position so the assertion below only holds
		// when block_number is genuinely the OUTER sort key, not merely present.
		await writeSeedParquet(
			[
				row(0, { block_number: 300, block_position: 20 }),
				row(1, { block_number: 100, block_position: 21 }),
				row(2, { block_number: 200, block_position: 22 }),
			],
			path,
		);
		const rows = await read(path, `SELECT block_position FROM read_parquet('$PATH')`);
		expect(rows.map((r) => r.block_position)).toEqual([21, 22, 20]);
	});

	it('returns the number of rows written', async () => {
		const path = join(dir, 'count.parquet');
		await expect(writeSeedParquet([row(0), row(1)], path)).resolves.toBe(2);
	});

	it('refuses to write an empty Seed file', async () => {
		await expect(writeSeedParquet([], join(dir, 'empty.parquet'))).rejects.toThrow(/no rows/i);
	});

	it('replaces an existing file so re-ingesting a range is idempotent', async () => {
		const path = join(dir, 'idempotent.parquet');
		await writeSeedParquet([row(0), row(1), row(2)], path);
		await writeSeedParquet([row(0)], path);
		const rows = await read(path, `SELECT block_position FROM read_parquet('$PATH')`);
		expect(rows).toHaveLength(1);
	});

	it('leaves no temp files beside the output', async () => {
		const path = join(dir, 'clean.parquet');
		await writeSeedParquet([row(0)], path);
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});
