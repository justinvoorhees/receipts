import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set BEFORE importing the route: the limits are read at module scope, and each
// vitest file gets its own module registry, so this file can pin a small
// ceiling without affecting the other suites.
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
	mockGet.mockResolvedValue(null);
	mockAnalyze.mockResolvedValue({ txHash: VALID_HASH, chainId: 8453 } as never);
	mockInsert.mockResolvedValue({ id: 1 } as never);
});

// With POST public, per-IP limits alone do not bound the bill: an attacker
// simply uses more IPs. The global ceiling is what actually caps spend, and it
// is the only limit that a distributed flood cannot walk around.
describe('global analysis ceiling', () => {
	it('refuses a fresh IP once the global ceiling is spent', async () => {
		// Drain the ceiling across many IPs, each staying under its own per-IP cap.
		for (let ip = 0; ip < 10; ip++) {
			for (let n = 0; n < 3; n++) await POST(post(`172.16.0.${ip}`));
		}
		const res = await POST(post('172.16.99.99'));
		expect(res.status).toBe(429);
	});

	it('stops spending RPC once the ceiling is reached', async () => {
		const before = mockAnalyze.mock.calls.length;
		for (let ip = 0; ip < 20; ip++) await POST(post(`172.17.0.${ip}`));
		// Whatever the ceiling allowed, it must be bounded — not one per request.
		expect(mockAnalyze.mock.calls.length - before).toBeLessThan(20);
	});

	it('tells the caller when to retry', async () => {
		for (let ip = 0; ip < 10; ip++) {
			for (let n = 0; n < 3; n++) await POST(post(`172.18.0.${ip}`));
		}
		const res = await POST(post('172.18.99.99'));
		expect(res.status).toBe(429);
		expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
	});

});
