import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { listReceipts, countReceipts, getReceiptByHash, insertReceipt, deleteReceipt } from './queries';

const DB = process.env.TCA_DATABASE_URL;

// Real seeded receipt hash (lower-case, as stored), mixed-case here to prove
// getReceiptByHash is case-insensitive.
const SEEDED_HASH_MIXED_CASE = '0xBDAA6662fa12410D329d8954E46ea611f8A3a2008426151CBA1C37121edbc9CE';

describe.runIf(DB)('receipts data layer', () => {
	it('getReceiptByHash finds a seeded receipt regardless of hash case', async () => {
		const r = await getReceiptByHash(SEEDED_HASH_MIXED_CASE);
		expect(r).not.toBeNull();
		expect(r?.txHash.toLowerCase()).toBe(SEEDED_HASH_MIXED_CASE.toLowerCase());
	});

	it('getReceiptByHash returns null for an unknown hash', async () => {
		const r = await getReceiptByHash('0x0000000000000000000000000000000000000000000000000000000000000000');
		expect(r).toBeNull();
	});

	it('listReceipts returns > 0 rows ordered by createdAt desc', async () => {
		const rows = await listReceipts({ limit: 500, offset: 0 });
		expect(rows.length).toBeGreaterThan(0);
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1];
			const curr = rows[i];
			if (!prev || !curr) throw new Error('unreachable');
			expect(new Date(prev.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(curr.createdAt).getTime());
		}
	});

	it('insertReceipt inserts a row and deleteReceipt removes it', async () => {
		const seed = await getReceiptByHash(SEEDED_HASH_MIXED_CASE);
		expect(seed).not.toBeNull();
		if (!seed) throw new Error('unreachable');

		const { id: _id, createdAt: _createdAt, ...rest } = seed;
		const inserted = await insertReceipt({
			...rest,
			userId: 'test-user-queries-ts',
			txHash: seed.txHash,
		});
		expect(inserted.id).toBeDefined();
		expect(inserted.txHash.toLowerCase()).toBe(seed.txHash.toLowerCase());

		await deleteReceipt(inserted.id);
		const after = await listReceipts({ limit: 500, offset: 0 });
		expect(after.find((r) => r.id === inserted.id)).toBeUndefined();
	});

	// The listing is bounded now: an unbounded select was both a memory hazard
	// and the query that degrades fastest as the table is spammed.
	it('listReceipts honours the limit', async () => {
		const rows = await listReceipts({ limit: 2, offset: 0 });
		expect(rows.length).toBeLessThanOrEqual(2);
	});

	it('listReceipts offsets into the same ordering rather than repeating page 1', async () => {
		const first = await listReceipts({ limit: 2, offset: 0 });
		const second = await listReceipts({ limit: 2, offset: 2 });
		if (first.length === 2 && second.length > 0) {
			expect(second.map((r) => r.id)).not.toEqual(first.map((r) => r.id));
		}
	});

	it('countReceipts counts every row, not just the current page', async () => {
		const total = await countReceipts();
		const page = await listReceipts({ limit: 1, offset: 0 });
		expect(total).toBeGreaterThanOrEqual(page.length);
		expect(Number.isInteger(total)).toBe(true);
	});
});
