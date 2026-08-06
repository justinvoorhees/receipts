import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./queries', () => ({ getReceiptByHash: vi.fn(async () => null) }));

const { getReceiptByHash } = await import('./queries');
const { loadReceipt } = await import('./loadReceipt');
const { DEFAULT_CHAIN } = await import('./chains');

const mockGet = vi.mocked(getReceiptByHash);

beforeEach(() => {
	vi.clearAllMocks();
});

const HASH = '0x' + 'a'.repeat(64);

describe('loadReceipt', () => {
	it('passes the hash through to the query', async () => {
		await loadReceipt(DEFAULT_CHAIN, HASH);
		expect(mockGet).toHaveBeenCalledWith(HASH);
	});

	it('returns the row it finds', async () => {
		const row = { id: 1, txHash: HASH, chainId: 8453 };
		mockGet.mockResolvedValueOnce(row as never);
		await expect(loadReceipt(DEFAULT_CHAIN, HASH)).resolves.toBe(row);
	});

	it('returns null on a miss', async () => {
		await expect(loadReceipt(DEFAULT_CHAIN, HASH)).resolves.toBeNull();
	});
});
