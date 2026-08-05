import { describe, it, expect, vi, beforeEach } from 'vitest';

// Its own file, because the limiters are module-scoped: a sibling test that
// drains the global ceiling would make this one fail for the wrong reason.
process.env.RATE_LIMIT_ANALYSES_PER_MIN = '5';
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '12';
process.env.TCA_RPC_URL = 'http://rpc.test';

vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: vi.fn(),
	enrichFeeSinkNames: vi.fn(async (s: unknown[]) => s),
}));
vi.mock('../../../lib/queries.js', () => ({
	getReceiptByHash: vi.fn(),
	insertReceipt: vi.fn(),
	deleteReceipt: vi.fn(),
	enrichLegRouters: vi.fn((row: unknown) => row),
}));

const { analyzeTransaction } = await import('@fabric-tca/core');
const { getReceiptByHash, insertReceipt } = await import('../../../lib/queries.js');
const { POST } = await import('./route.js');

const mockAnalyze = vi.mocked(analyzeTransaction);
const mockGet = vi.mocked(getReceiptByHash);
const mockInsert = vi.mocked(insertReceipt);

// Must satisfy the route's hash-syntax guard (0x + 64 hex chars) — anything
// shorter is rejected before it ever reaches these mocks.
const VALID_HASH = '0x' + 'a'.repeat(64);

const post = (ip: string) =>
	new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip },
		body: JSON.stringify({ hash: VALID_HASH }),
	});

beforeEach(() => {
	mockAnalyze.mockResolvedValue({ txHash: VALID_HASH, chainId: 8453 } as never);
	mockInsert.mockResolvedValue({ id: 1 } as never);
});

// A cache hit costs no RPC, so it must not consume the analysis ceiling — else a
// single popular receipt viewed repeatedly could lock out genuine new analyses
// for everyone, which is a self-inflicted denial of service.
describe('the global ceiling is spent by analyses, not by cache hits', () => {
	it('leaves the ceiling intact after many cache hits', async () => {
		mockGet.mockResolvedValue({ id: 7, txHash: VALID_HASH } as never);
		for (let i = 0; i < 60; i++) await POST(post(`10.20.0.${i % 200}`));
		expect(mockAnalyze).not.toHaveBeenCalled();

		// The ceiling is 12 and untouched, so a fresh client can still analyze.
		mockGet.mockResolvedValue(null);
		expect((await POST(post('10.20.99.1'))).status).toBe(200);
		expect(mockAnalyze).toHaveBeenCalledOnce();
	});
});
