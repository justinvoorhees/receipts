import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyQueryToParquet, writeRowsToParquet } from './writeParquet.js';

const SPEC = "{'n': 'INTEGER', 'label': 'VARCHAR'}";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'writeParquet-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function readBack(path: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${path}')`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

describe('writeRowsToParquet', () => {
	it('writes rows and orders them at write time', async () => {
		const out = join(dir, 'out.parquet');
		const count = await writeRowsToParquet(
			[
				{ n: 3, label: 'c' },
				{ n: 1, label: 'a' },
				{ n: 2, label: 'b' },
			],
			{ outPath: out, columnSpec: SPEC, orderBy: 'n' },
		);
		expect(count).toBe(3);
		const rows = await readBack(out);
		expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);
	});

	it('refuses to write an empty file', async () => {
		await expect(
			writeRowsToParquet([], { outPath: join(dir, 'x.parquet'), columnSpec: SPEC, orderBy: 'n' }),
		).rejects.toThrow(/no rows/);
	});

	it('leaves no temp files behind on success', async () => {
		await writeRowsToParquet([{ n: 1, label: 'a' }], {
			outPath: join(dir, 'out.parquet'),
			columnSpec: SPEC,
			orderBy: 'n',
		});
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});

	it('leaves no temp files behind on failure', async () => {
		await expect(
			writeRowsToParquet([{ n: 1, label: 'a' }], {
				outPath: join(dir, 'out.parquet'),
				columnSpec: "{'n': 'NOT_A_TYPE'}",
				orderBy: 'n',
			}),
		).rejects.toThrow();
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});

describe('copyQueryToParquet', () => {
	it('writes the result of a query and returns its row count', async () => {
		const out = join(dir, 'q.parquet');
		const count = await copyQueryToParquet({
			outPath: out,
			setupSql: ['CREATE TABLE t (n INTEGER, label VARCHAR)', "INSERT INTO t VALUES (2,'b'),(1,'a')"],
			selectSql: 'SELECT * FROM t ORDER BY n',
		});
		expect(count).toBe(2);
		const rows = await readBack(out);
		expect(rows.map((r) => r.label)).toEqual(['a', 'b']);
	});

	it('refuses to write an empty result', async () => {
		await expect(
			copyQueryToParquet({
				outPath: join(dir, 'empty.parquet'),
				setupSql: ['CREATE TABLE t (n INTEGER)'],
				selectSql: 'SELECT * FROM t',
			}),
		).rejects.toThrow(/no rows/);
	});

	it('leaves no temp files behind when the query is invalid', async () => {
		await expect(
			copyQueryToParquet({ outPath: join(dir, 'bad.parquet'), selectSql: 'SELECT * FROM nope' }),
		).rejects.toThrow();
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});
