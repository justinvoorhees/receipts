import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSeedRows, type BlockPayloads, type IngestMeta } from './buildSeedRows.js';
import type { TraceEntry } from './rpcTypes.js';

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
		// Reverse traceBlock itself, not receipts. The prior version of this
		// test only reversed `receipts`, which never disturbs the loop order
		// (the loop walks `traceBlock`) — a mutant that used the loop counter
		// as block_position produced [0,1,2] after the final sort regardless,
		// so the assertion held for BOTH the faithful and the broken
		// implementation. Reversing traceBlock makes the loop order diverge
		// from the true position order, and comparing each row's position
		// against its OWN receipt (looked up by hash, independent of any
		// array order) is what a loop-counter implementation cannot satisfy.
		p.traceBlock.reverse();
		const rows = buildSeedRows(p, META);
		const truePositionByHash = new Map(
			p.receipts.map((r) => [r.transactionHash.toLowerCase(), Number.parseInt(r.transactionIndex, 16)]),
		);
		for (const row of rows) {
			expect(row.block_position).toBe(truePositionByHash.get(row.tx_hash));
		}
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

	describe('duplicate transaction hashes (equal counts can still hide a mispair)', () => {
		it('aborts when a receipt hash is duplicated within the receipts payload', () => {
			const p = payloads();
			// Counts stay 3/3/3 — only a duplicate CHECK, not a length check,
			// can catch this. The duplicated hash also silently drops the
			// receipt whose hash it overwrote from the effective set.
			p.receipts[1]!.transactionHash = p.receipts[0]!.transactionHash;
			expect(() => buildSeedRows(p, META)).toThrow(/duplicate/i);
		});

		it('aborts when a tx hash is duplicated within the block payload', () => {
			const p = payloads();
			(p.block.transactions[1] as Record<string, unknown>).hash = p.block.transactions[0]!.hash;
			expect(() => buildSeedRows(p, META)).toThrow(/duplicate/i);
		});

		it('aborts when a trace hash is duplicated within the traceBlock payload', () => {
			const p = payloads();
			p.traceBlock[1]!.txHash = p.traceBlock[0]!.txHash;
			// Anchored on the trace guard's OWN wording. A duplicated trace hash
			// also trips the block_position collision check further down (both
			// entries resolve to the same receipt), whose message likewise
			// contains "Duplicate" — so a loose /duplicate/i passed with the
			// trace-duplicate guard deleted, which is exactly the mutant this
			// test exists to catch.
			expect(() => buildSeedRows(p, META)).toThrow(/duplicate txHash among trace entries/i);
		});
	});

	describe('block_position validation', () => {
		it('aborts when a hex quantity field cannot be parsed', () => {
			const p = payloads();
			p.receipts[0]!.transactionIndex = 'not-hex';
			// Asserting on the parse-guard's own wording, not just the field
			// name: a malformed receipt.transactionIndex ALSO trips the
			// receipt-vs-tx cross-check (its message happens to contain
			// "transactionIndex" too, since NaN !== a real number), so a
			// generic /transactionIndex/i regex would still pass with the
			// parse guard itself deleted. "Expected a hex quantity" is the
			// guard's own text and nothing else produces it.
			expect(() => buildSeedRows(p, META)).toThrow(/expected a hex quantity for receipt\.transactionIndex/i);
		});

		it('aborts when transactionIndex is missing rather than silently sorting as NaN', () => {
			const p = payloads();
			delete (p.receipts[0] as Record<string, unknown>).transactionIndex;
			expect(() => buildSeedRows(p, META)).toThrow(/expected a hex quantity for receipt\.transactionIndex/i);
		});

		it('aborts when two rows would share the same block_position', () => {
			const p = payloads();
			const dupIndex = p.receipts[1]!.transactionIndex;
			p.receipts[0]!.transactionIndex = dupIndex;
			// Keep the tx envelope's own transactionIndex in agreement with its
			// receipt, so the collision check — not the cross-check below — is
			// what actually fires here.
			(p.block.transactions[0] as Record<string, unknown>).transactionIndex = dupIndex;
			expect(() => buildSeedRows(p, META)).toThrow(/block_position/i);
		});

		it('aborts when receipt.transactionIndex disagrees with the tx envelope', () => {
			const p = payloads();
			(p.block.transactions[0] as Record<string, unknown>).transactionIndex = '0x63';
			expect(() => buildSeedRows(p, META)).toThrow(/transactionIndex/i);
		});
	});

	it('aborts when a trace entry has no result', () => {
		const p = payloads();
		delete (p.traceBlock[0] as Partial<TraceEntry>).result;
		expect(() => buildSeedRows(p, META)).toThrow(/result/i);
	});

	describe('cross-payload block identity', () => {
		it('aborts when a receipt reports a different block hash than the block payload', () => {
			const p = payloads();
			p.receipts[0]!.blockHash = '0x' + 'ab'.repeat(32);
			expect(() => buildSeedRows(p, META)).toThrow(/block/i);
		});

		it('aborts when a receipt reports a different block number than the block payload', () => {
			const p = payloads();
			p.receipts[0]!.blockNumber = '0x1';
			expect(() => buildSeedRows(p, META)).toThrow(/block/i);
		});

		it('aborts when a tx envelope reports a different block hash than the block payload', () => {
			const p = payloads();
			(p.block.transactions[0] as Record<string, unknown>).blockHash = '0x' + 'ab'.repeat(32);
			expect(() => buildSeedRows(p, META)).toThrow(/block/i);
		});
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
		p.receipts[0]!.to = null;
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_to).toBeNull();
	});

	it('takes tx_to from the receipt, not the tx envelope, when they disagree', () => {
		const p = payloads();
		(p.block.transactions[0] as Record<string, unknown>).to =
			'0x1111111111111111111111111111111111111111';
		p.receipts[0]!.to = '0x2222222222222222222222222222222222222222';
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_to).toBe('0x2222222222222222222222222222222222222222');
	});

	it('does not coerce an empty-string receipt.to into NULL', () => {
		const p = payloads();
		p.receipts[0]!.to = '';
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_to).toBe('');
	});

	it('lowercases the promoted address and hash columns', () => {
		const p = payloads();
		p.receipts[0]!.transactionHash = p.receipts[0]!.transactionHash.toUpperCase().replace('0X', '0x');
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_hash).toBe(row!.tx_hash.toLowerCase());
		expect(row!.tx_from).toBe(row!.tx_from.toLowerCase());
	});

	describe('tx_status — the one boolean PRUNING column', () => {
		it('maps receipt status 0x1 to true and 0x0 to false', () => {
			const p = payloads();
			p.receipts[0]!.status = '0x0';
			const rows = buildSeedRows(p, META);
			expect(rows[0]!.tx_status).toBe(false);
			expect(rows[1]!.tx_status).toBe(true);
		});

		// A zero-padded status is a real cross-client variation. Read as
		// `status === '0x1'` it silently marks EVERY transaction in an
		// immutable file as reverted, with no error anywhere.
		it('accepts a zero-padded status rather than reading 0x01 as a revert', () => {
			const p = payloads();
			p.receipts[0]!.status = '0x01';
			expect(buildSeedRows(p, META)[0]!.tx_status).toBe(true);
		});

		it('accepts a zero-padded failure status', () => {
			const p = payloads();
			p.receipts[0]!.status = '0x00';
			expect(buildSeedRows(p, META)[0]!.tx_status).toBe(false);
		});

		it('accepts an upper-case hex status', () => {
			const p = payloads();
			p.receipts[0]!.status = '0X1';
			expect(buildSeedRows(p, META)[0]!.tx_status).toBe(true);
		});

		it('aborts on a missing status instead of recording a silent false', () => {
			const p = payloads();
			delete (p.receipts[0] as Record<string, unknown>).status;
			expect(() => buildSeedRows(p, META)).toThrow(/receipt\.status to be 0x1 or 0x0/i);
		});

		it('aborts on a status it does not understand rather than guessing', () => {
			const p = payloads();
			p.receipts[0]!.status = '0x2';
			expect(() => buildSeedRows(p, META)).toThrow(/receipt\.status to be 0x1 or 0x0/i);
		});

		it('aborts on a non-string status (a pre-Byzantium root, say)', () => {
			const p = payloads();
			(p.receipts[0] as Record<string, unknown>).status = 1;
			expect(() => buildSeedRows(p, META)).toThrow(/receipt\.status to be 0x1 or 0x0/i);
		});
	});

	// `result: null` used to pass the `=== undefined` guard and serialize as the
	// four-character string "null", which downstream cannot tell apart from a
	// genuine null trace: absent read as measured, permanently.
	it('aborts when a trace entry result is explicitly null', () => {
		const p = payloads();
		p.traceBlock[0]!.result = null;
		expect(() => buildSeedRows(p, META)).toThrow(/has no result/i);
	});

	describe('missing promoted string fields name themselves', () => {
		it.each([
			['from', /receipt\.from/],
			['to', /receipt\.to/],
			['blockHash', /receipt\.blockHash/],
		])('names receipt.%s rather than throwing on undefined.toLowerCase', (field, pattern) => {
			const p = payloads();
			delete (p.receipts[0] as Record<string, unknown>)[field];
			expect(() => buildSeedRows(p, META)).toThrow(pattern);
			expect(() => buildSeedRows(p, META)).not.toThrow(/Cannot read properties/);
		});
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
		const srcTx = original.block.transactions.find((t) => t.hash.toLowerCase() === hash);
		const { transactions: _omitted, ...srcHeader } = original.block;
		// `.toBe` on the serialized string, not `.toEqual` on the parsed
		// object: `toEqual` compares structurally and would pass even if key
		// order were scrambled during assembly, but the payload standard
		// forbids exactly that — reordering keys is still a transformation.
		expect(row!.receipt_json).toBe(JSON.stringify(srcReceipt));
		expect(row!.tx_json).toBe(JSON.stringify(srcTx));
		expect(row!.block_json).toBe(JSON.stringify(srcHeader));
	});
});
