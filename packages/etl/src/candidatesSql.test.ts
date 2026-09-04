import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidatesSelectSql, candidatesSetupSql, HEX_TO_DEC_MACRO, SWAP_TOPICS, TRANSFER_TOPIC } from './candidatesSql.js';
import { routerValuesSql } from './routerRegistry.js';
import type { SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';

function log(address: string, topics: string[]) {
	return { address, topics, data: '0x' };
}

function seedRow(over: Partial<SeedRow> & { tx_hash: string; block_position: number }): SeedRow {
	return {
		chain_id: 8453,
		block_number: 50842630,
		block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom',
		tx_to: '0xdead',
		tx_status: true,
		block_hash: '0xblock',
		trace_json: '{}',
		receipt_json: JSON.stringify({ logs: [], gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }),
		tx_json: JSON.stringify({ value: '0x0' }),
		block_json: '{}',
		finality: 'finalized',
		ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test',
		schema_version: 1,
		...over,
	} as SeedRow;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'candidatesSql-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function runCandidates(rows: SeedRow[]): Promise<Record<string, unknown>[]> {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(rows, seedPath);

	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		for (const statement of candidatesSetupSql({
			seedGlob: seedPath,
			routerValues: routerValuesSql([{ address: ROUTER, name: '1inch', version: 'V5' }]),
		})) {
			await connection.run(statement);
		}
		const reader = await connection.runAndReadAll(
			candidatesSelectSql({
				seedFile: 'traces.base.0050842630-0050842929.parquet',
				derivedAt: '2026-09-04T12:00:00.000Z',
				schemaVersion: 1,
			}),
		);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

describe('hex_to_dec', () => {
	async function hexToDec(value: string | null): Promise<string | null> {
		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		try {
			await connection.run(HEX_TO_DEC_MACRO);
			const literal = value === null ? 'NULL' : `'${value}'`;
			const reader = await connection.runAndReadAll(`SELECT hex_to_dec(${literal}) AS v`);
			return reader.getRowObjects()[0]!.v as string | null;
		} finally {
			connection.closeSync();
			instance.closeSync();
		}
	}

	it('converts hex wei to a decimal string', async () => {
		expect(await hexToDec('0x0de0b6b3a7640000')).toBe('1000000000000000000');
	});

	it('handles zero in both spellings', async () => {
		expect(await hexToDec('0x0')).toBe('0');
		expect(await hexToDec('0x00')).toBe('0');
	});

	it('passes NULL through', async () => {
		expect(await hexToDec(null)).toBeNull();
	});

	it('yields NULL rather than overflowing on a value wider than 2^128', async () => {
		// A full uint256 would abort the entire COPY with an overflow error.
		expect(
			await hexToDec('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
		).toBeNull();
	});

	it('still converts the largest genuine 128-bit value', async () => {
		expect(await hexToDec('0xffffffffffffffffffffffffffffffff')).toBe(
			'340282366920938463463374607431768211455',
		);
	});
});

describe('candidates selection', () => {
	it('selects a tx with a Swap log as swap_log', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xa',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.selected_via).toBe('swap_log');
		expect(Number(rows[0]!.swap_log_count)).toBe(1);
		expect(rows[0]!.router_name).toBeNull();
	});

	it('selects a router tx with no Swap log as router, and keeps it', async () => {
		const rows = await runCandidates([
			seedRow({ tx_hash: '0xb', block_position: 0, tx_to: ROUTER }),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.selected_via).toBe('router');
		expect(rows[0]!.router_name).toBe('1inch');
		expect(Number(rows[0]!.swap_log_count)).toBe(0);
		expect(Number(rows[0]!.distinct_pools)).toBe(0);
	});

	it('selects a router tx WITH a Swap log as both', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xc',
				block_position: 0,
				tx_to: ROUTER.toUpperCase(),
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v2])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows[0]!.selected_via).toBe('both');
		expect(rows[0]!.router_name).toBe('1inch');
	});

	it('excludes a tx that is neither a router call nor a swap', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xd',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xtoken', [TRANSFER_TOPIC])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
			// A second row so the file is not empty when the first is excluded.
			seedRow({
				tx_hash: '0xe',
				block_position: 1,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows.map((r) => r.tx_hash)).toEqual(['0xe']);
	});
});

describe('candidates pool counting', () => {
	it('counts a v4 pool by poolId, NOT by the emitting singleton', async () => {
		// Both legs come from ONE singleton but are TWO different pools. Counting
		// DISTINCT emitter would report 1 and understate the pool count — the
		// defect that made 485 pilot pools look like 2.
		const singleton = '0x498581ff718922c3f8e6a244956af099b2652b2b';
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xf',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [
						log(singleton, [SWAP_TOPICS.v4, '0xpoolid1']),
						log(singleton, [SWAP_TOPICS.v4, '0xpoolid2']),
					],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.v4_legs)).toBe(2);
		expect(Number(rows[0]!.distinct_v4_poolids)).toBe(2);
		expect(Number(rows[0]!.distinct_pools)).toBe(2);
	});

	it('counts repeated hits on one pool once', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x10',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3]), log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.v3_legs)).toBe(2);
		expect(Number(rows[0]!.distinct_pools)).toBe(1);
	});

	it('counts transfers and total logs separately from swaps', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x11',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [
						log('0xtoken', [TRANSFER_TOPIC]),
						log('0xtoken', [TRANSFER_TOPIC]),
						log('0xpool1', [SWAP_TOPICS.v2]),
					],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.log_count)).toBe(3);
		expect(Number(rows[0]!.erc20_transfer_count)).toBe(2);
		expect(Number(rows[0]!.swap_log_count)).toBe(1);
	});
});

describe('candidates gas and value columns', () => {
	it('decodes gas and value, and tolerates an absent l1Fee', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x12',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x5b8d80',
				}),
				tx_json: JSON.stringify({ value: '0x0de0b6b3a7640000' }),
			}),
		]);
		expect(Number(rows[0]!.gas_used)).toBe(21000);
		expect(rows[0]!.effective_gas_price).toBe('6000000');
		expect(rows[0]!.l1_fee).toBeNull();
		expect(rows[0]!.tx_value).toBe('1000000000000000000');
	});

	it('stamps provenance on every row', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x13',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows[0]!.seed_file).toBe('traces.base.0050842630-0050842929.parquet');
		expect(Number(rows[0]!.derived_schema_version)).toBe(1);
	});
});
