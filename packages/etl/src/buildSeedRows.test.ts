import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSeedRows, type BlockPayloads, type IngestMeta } from './buildSeedRows.js';

// Read rather than `import ... with { type: 'json' }`: under NodeNext ESM the
// import attribute is required at runtime but handled differently by vitest's
// transform, and reading sidesteps the question entirely. It also gives every
// test a fresh deep copy for free.
// `import.meta.url` is correct here and nowhere else in this package: a test
// fixture is source-adjacent and never built or deployed, so there is no build
// machine whose absolute path could get baked in. Runtime DATA paths still come
// from a CLI argument — see Global Constraints.
const RAW = readFileSync(
	fileURLToPath(new URL('./__fixtures__/block-50795977.json', import.meta.url)),
	'utf8',
);

const META: IngestMeta = {
	chainId: 8453,
	finality: 'finalized',
	ingestedAt: '2026-09-03T12:00:00.000Z',
	source: 'quicknode-base-mainnet',
};

const payloads = (): BlockPayloads => JSON.parse(RAW) as BlockPayloads;

describe('buildSeedRows', () => {
	it('emits one row per transaction', () => {
		const rows = buildSeedRows(payloads(), META);
		expect(rows).toHaveLength(3);
	});

	it('stamps identity, provenance and the block header on every row', () => {
		const [row] = buildSeedRows(payloads(), META);
		expect(row!.chain_id).toBe(8453);
		expect(row!.block_number).toBe(50795977);
		expect(row!.finality).toBe('finalized');
		expect(row!.source).toBe('quicknode-base-mainnet');
		expect(row!.schema_version).toBe(1);
		expect(row!.block_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('pairs each trace with the receipt and tx of the SAME hash, not the same index', () => {
		const p = payloads();
		// Reverse ONE payload's ordering. Index-based assembly would now
		// mis-pair every row; hash-based assembly is unaffected.
		p.receipts.reverse();
		const rows = buildSeedRows(p, META);
		for (const row of rows) {
			expect(JSON.parse(row.receipt_json).transactionHash.toLowerCase()).toBe(row.tx_hash);
			expect(JSON.parse(row.tx_json).hash.toLowerCase()).toBe(row.tx_hash);
			expect(JSON.parse(row.trace_json)).toBeTypeOf('object');
		}
	});

	it('takes block_position from the receipt, not from array order', () => {
		const p = payloads();
		p.receipts.reverse();
		const rows = buildSeedRows(p, META);
		expect(rows.map((r) => r.block_position)).toEqual([0, 1, 2]);
	});

	it('returns no rows for an empty block without treating it as an error', () => {
		const p = payloads();
		p.traceBlock = [];
		p.receipts = [];
		p.block.transactions = [];
		expect(buildSeedRows(p, META)).toEqual([]);
	});

	it('aborts the block when the payloads disagree on transaction count', () => {
		const p = payloads();
		p.receipts.pop();
		expect(() => buildSeedRows(p, META)).toThrow(/transaction count/i);
	});

	it('aborts the block when a trace has no matching receipt', () => {
		const p = payloads();
		p.receipts[0]!.transactionHash = '0x' + 'de'.repeat(32);
		expect(() => buildSeedRows(p, META)).toThrow(/no receipt/i);
	});

	it('strips the transaction list out of block_json and keeps the rest', () => {
		const [row] = buildSeedRows(payloads(), META);
		const header = JSON.parse(row!.block_json);
		expect(header.transactions).toBeUndefined();
		expect(header.baseFeePerGas).toBeDefined();
		expect(header.hash).toBe(row!.block_hash);
	});

	it('records tx_to as NULL for a contract creation', () => {
		const p = payloads();
		delete (p.block.transactions[0] as Record<string, unknown>).to;
		p.receipts[0]!.to = null;
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_to).toBeNull();
	});

	it('lowercases the promoted address and hash columns', () => {
		const p = payloads();
		p.receipts[0]!.transactionHash = p.receipts[0]!.transactionHash.toUpperCase().replace('0X', '0x');
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_hash).toBe(row!.tx_hash.toLowerCase());
		expect(row!.tx_from).toBe(row!.tx_from.toLowerCase());
	});

	it('maps receipt status 0x1 to true and 0x0 to false', () => {
		const p = payloads();
		p.receipts[0]!.status = '0x0';
		const rows = buildSeedRows(p, META);
		expect(rows[0]!.tx_status).toBe(false);
	});

	/**
	 * Pins the spec's payload standard (§3). Semantic losslessness is only
	 * equivalent to byte preservation because every scalar in these payloads is
	 * a hex string, boolean or null — there is no JSON number to round-trip
	 * through an IEEE-754 double. If a client upgrade ever emits a bare number,
	 * this fails and the standard must be revisited rather than silently broken.
	 */
	it('contains no JSON numbers anywhere in any payload', () => {
		const offenders: string[] = [];
		const walk = (node: unknown, path: string): void => {
			if (typeof node === 'number') offenders.push(`${path} = ${node}`);
			else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
			else if (node && typeof node === 'object') {
				for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
			}
		};
		walk(JSON.parse(RAW), '$');
		expect(offenders).toEqual([]);
	});

	it('preserves payload content exactly, adding and removing nothing', () => {
		const p = payloads();
		const [row] = buildSeedRows(p, META);
		const original = payloads();
		const hash = row!.tx_hash;
		const srcReceipt = original.receipts.find((r) => r.transactionHash.toLowerCase() === hash);
		expect(JSON.parse(row!.receipt_json)).toEqual(srcReceipt);
	});
});
