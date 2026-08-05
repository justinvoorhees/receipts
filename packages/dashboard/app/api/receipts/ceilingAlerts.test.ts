import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.RATE_LIMIT_ANALYSES_PER_MIN = '100';
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '10';
process.env.TCA_RPC_URL = 'http://rpc.test';
process.env.ALERT_WEBHOOK_URL = 'https://hook.test/alert';

const notified: Array<{ kind: string; text: string }> = [];
const created: Array<{ webhookUrl?: string; debounceMs?: number }> = [];

vi.mock('../../../lib/alerts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/alerts')>();
	return {
		...actual,
		createNotifier: (opts: { webhookUrl?: string; debounceMs?: number } = {}) => {
			created.push(opts);
			return async (kind: string, text: string) => { notified.push({ kind, text }); };
		},
	};
});
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
		headers: { 'x-forwarded-for': ip, host: 'app.test' },
		body: JSON.stringify({ hash: VALID_HASH }),
	});

beforeEach(() => {
	notified.length = 0;
	mockGet.mockResolvedValue(null);
	mockAnalyze.mockResolvedValue({ txHash: VALID_HASH, chainId: 8453 } as never);
	mockInsert.mockResolvedValue({
		id: 1, txHash: VALID_HASH, aggregator: '0x', inputSymbol: 'WETH',
		outputSymbol: 'USDC', notionalUsd: '100', allInCostBps: '5',
	} as never);
});

/**
 * ⚠️ The global limiter lives at module scope, so its counter ACCUMULATES
 * across the tests in this file — it is one hour-long window and nothing
 * resets it. These tests therefore run as a deliberate progression from a
 * healthy budget to an exhausted one, and the request counts below are
 * cumulative. Reordering them will produce vacuous passes: a "no warning yet"
 * assertion trivially holds once the ceiling is already spent, because the
 * request is rejected before the warning check is ever reached.
 *
 * Ceiling is 10 and the warning fraction is 0.2, so the threshold is
 * `remaining <= 2` — the 8th analysis warns.
 */
describe('ceiling alerting', () => {
	it('configures the alert stream with a debounce', () => {
		const alert = created.find((c) => c.webhookUrl === 'https://hook.test/alert');
		expect(alert).toBeDefined();
		expect(alert!.debounceMs).toBeGreaterThan(0);
	});

	it('stays quiet while the budget is healthy', async () => {
		await POST(post('10.0.0.1')); // cumulative: 1 of 10, remaining 9
		// Scoped to the alert stream: a successful insert also emits a
		// `receipt_created` on the separate activity stream, which is expected
		// here and says nothing about budget health.
		expect(notified.filter((n) => n.kind !== 'receipt_created')).toHaveLength(0);
	});

	it('warns before the ceiling is reached, not only after', async () => {
		for (let n = 0; n < 7; n++) await POST(post(`10.1.0.${n}`)); // cumulative: 8 of 10, remaining 2
		expect(notified.some((n) => n.kind === 'budget_warning')).toBe(true);
		expect(notified.some((n) => n.kind === 'ceiling_reached')).toBe(false);
	});

	it('alerts when the ceiling is actually reached', async () => {
		for (let n = 0; n < 3; n++) await POST(post(`10.2.0.${n}`)); // cumulative: 11 of 10 — over
		const alert = notified.find((n) => n.kind === 'ceiling_reached');
		expect(alert).toBeDefined();
		expect(alert!.text).toContain('10');
	});
});
