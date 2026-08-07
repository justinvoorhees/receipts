import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';
import { getReceiptByHash, insertReceipt } from './queries';

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

	it('insertReceipt inserts a row', async () => {
		const seed = await getReceiptByHash(SEEDED_HASH_MIXED_CASE);
		expect(seed).not.toBeNull();
		if (!seed) throw new Error('unreachable');

		const { id: _id, createdAt: _createdAt, ...rest } = seed;
		const inserted = await insertReceipt({
			...rest,
			userId: 'test-user-queries-ts',
			txHash: seed.txHash,
		});
		try {
			expect(inserted.id).toBeDefined();
			expect(inserted.txHash.toLowerCase()).toBe(seed.txHash.toLowerCase());
		} finally {
			// The app no longer has a delete path (its only caller was removed with
			// the history table), so this test cleans up its own row directly —
			// otherwise a second run trips the unique constraint on re-insert.
			await getDb().delete(schema.receipts).where(eq(schema.receipts.id, inserted.id));
		}
	});
});
