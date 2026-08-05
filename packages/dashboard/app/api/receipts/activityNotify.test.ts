import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.RATE_LIMIT_ANALYSES_PER_MIN = '100';
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '100';
process.env.TCA_RPC_URL = 'http://rpc.test';
process.env.ALERT_WEBHOOK_URL = 'https://hook.test/alert';
process.env.ACTIVITY_WEBHOOK_URL = 'https://hook.test/activity';

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

const row = {
	id: 1, txHash: VALID_HASH, aggregator: '0x', inputSymbol: 'WETH',
	outputSymbol: 'USDC', notionalUsd: '4210', allInCostBps: '12.3',
};

const post = (hash = VALID_HASH) =>
	new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': '10.9.0.1', host: 'app.test', 'x-forwarded-proto': 'https' },
		body: JSON.stringify({ hash }),
	});

beforeEach(() => {
	notified.length = 0;
	vi.clearAllMocks();
	mockAnalyze.mockResolvedValue({ txHash: VALID_HASH, chainId: 8453 } as never);
	mockInsert.mockResolvedValue(row as never);
});

describe('activity notification', () => {
	// The two streams must not share a destination: activity volume would bury
	// a ceiling warning in the same channel, exactly when that warning matters. And
	// activity must not debounce, or a launch-day burst reports only the first.
	it('routes activity to its own webhook, undebounced, separate from alerts', () => {
		const alert = created.find((c) => c.webhookUrl === 'https://hook.test/alert');
		const activity = created.find((c) => c.webhookUrl === 'https://hook.test/activity');
		expect(alert).toBeDefined();
		expect(activity).toBeDefined();
		expect(activity!.debounceMs ?? 0).toBe(0);
		expect(alert!.debounceMs).toBeGreaterThan(0);
	});

	it('sends exactly one message when a receipt is newly generated', async () => {
		mockGet.mockResolvedValue(null);
		await POST(post());
		const events = notified.filter((n) => n.kind === 'receipt_created');
		expect(events).toHaveLength(1);
		expect(events[0]!.text).toContain('WETH');
		expect(events[0]!.text).toContain(`https://app.test/?tx=${VALID_HASH}`);
	});

	// A shared link is viewed far more often than it is generated. Notifying on
	// a cache hit would report one trade thousands of times.
	it('sends nothing when the receipt is served from the database', async () => {
		mockGet.mockResolvedValue(row as never);
		await POST(post());
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});

	// The winner of the insert race already notified; the loser must not repeat it.
	it('sends nothing when a concurrent insert won the race', async () => {
		mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(row as never);
		mockInsert.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
		const res = await POST(post());
		expect(res.status).toBe(200);
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});

	it('does not fail the request when analysis produced nothing', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(null as never);
		const res = await POST(post());
		expect(res.status).toBe(404);
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});
});
