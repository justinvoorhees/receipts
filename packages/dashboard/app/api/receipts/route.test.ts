import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Receipt } from '@fabric-tca/core';

vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: vi.fn(),
	enrichFeeSinkNames: vi.fn(async (sinks: { address: string; feeBps: number; source: string }[]) => sinks.map((s) => ({ ...s, name: null }))),
}));
vi.mock('../../../lib/queries.js', () => ({
	getReceiptByHash: vi.fn(),
	insertReceipt: vi.fn(),
	deleteReceipt: vi.fn(),
	// Identity here: the route only needs to see it's applied, not what it does —
	// enrichLegRouters itself is covered by legRouterEnrichment.test.ts.
	enrichLegRouters: vi.fn((row: unknown) => row),
}));

import { analyzeTransaction } from '@fabric-tca/core';
import { deleteReceipt, enrichLegRouters, getReceiptByHash, insertReceipt } from '../../../lib/queries.js';
import { DELETE, POST } from './route.js';
import { SESSION_COOKIE, signSession } from '../../../lib/auth';

const mockAnalyze = vi.mocked(analyzeTransaction);
const mockGet = vi.mocked(getReceiptByHash);
const mockInsert = vi.mocked(insertReceipt);
const mockEnrich = vi.mocked(enrichLegRouters);
const mockDelete = vi.mocked(deleteReceipt);

// Must satisfy the route's hash-syntax guard (0x + 64 hex chars) — anything
// shorter is rejected before it ever reaches these mocks.
const VALID_HASH = '0x' + 'a'.repeat(64);
const NOT_FOUND_HASH = '0x' + 'b'.repeat(64);

function post(body: unknown): Request {
	return new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': nextIp() },
		body: JSON.stringify(body),
	});
}

// Rate limiting is keyed on client IP, so every test gets its own address
// unless it is deliberately exercising the limiter. Without this, unrelated
// tests would share one bucket and start tripping each other's limits.
let ipSeq = 0;
function nextIp(): string {
	return `10.1.${Math.floor(++ipSeq / 254)}.${(ipSeq % 254) + 1}`;
}
function postFrom(ip: string, body: unknown): Request {
	return new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip },
		body: JSON.stringify(body),
	});
}

const sampleReceipt: Receipt = {
	txHash: VALID_HASH,
	chainId: 8453,
	blockNumber: 123,
	aggregator: '0xagg',
	routerAddress: '0xagg',
	trader: '0xtrader',
	fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
	direction: 'buy_weth',
	inputToken: '0xusdc',
	outputToken: '0xweth',
	inputSymbol: 'USDC',
	outputSymbol: 'WETH',
	inputAmount: 1000.5,
	outputAmount: 0.42,
	notionalUsd: 1000.5,
	realizedPrice: 2380.1,
	marketMid: 2381.0,
	marketMidBefore: 2380.5,
	marketMidAfter: 2381.5,
	allInCostBps: 12.3,
	pricingStatus: 'full',
	tier: 'full',
	methodology: 'pool',
	marketPriceFlags: [],
	executionBps: 5.1,
	lpFeeBps: 5.0,
	aggFeeBps: 2.0,
	slippageBps: 0.2,
	gasCostUsd: 0.5,
	routePure: true,
	routeShape: 'single',
	hopCount: 1,
	routeLegs: [{ venue: '0xpool' }],
	reconResidualBps: null,
	decompConfidence: 'high',
	feeRecipient: null,
	feeSinkSource: null,
	feeSinks: [],
	integratorFeeBps: null,
	fabricFeeBps: null,
	settlementEventName: 'Swap',
	settlementEventTopic0: '0xtopic',
	settlementEventSeen: true,
	normalizeFlags: ['x'],
	chainlinkPrice: 2381.5,
	chainlinkDevBps: 0.1,
	poolDivergenceBps: 0.05,
	manipulationFlag: false,
	offchainPrice: null,
	offchainDevBps: null,
	chainlinkStalenessSecs: 12,
};

describe('POST /api/receipts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.TCA_RPC_URL = 'http://rpc.test';
	});

	it('404s "Transaction not found." when analysis yields null', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(null);

		const res = await POST(post({ hash: NOT_FOUND_HASH }));

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Transaction not found.' });
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('200s with the existing stored row without re-analyzing', async () => {
		const stored = { id: 7, txHash: VALID_HASH } as never;
		mockGet.mockResolvedValue(stored);

		const res = await POST(post({ hash: VALID_HASH }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(stored);
		expect(mockAnalyze).not.toHaveBeenCalled();
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('200s computing and inserting when not previously stored', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		const inserted = { id: 42, txHash: VALID_HASH } as never;
		mockInsert.mockResolvedValue(inserted);

		const res = await POST(post({ hash: VALID_HASH }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(inserted);
		expect(mockAnalyze).toHaveBeenCalledOnce();
		expect(mockInsert).toHaveBeenCalledOnce();
		// Finding 3: the fresh-analysis path must enrich too, so it returns the
		// same shape as the cache-hit path (getReceiptByHash is enriched by queries.ts).
		expect(mockEnrich).toHaveBeenCalledWith(inserted);

		// numeric columns must be strings for Drizzle numeric inserts
		const arg = mockInsert.mock.calls[0]![0] as Record<string, unknown>;
		expect(arg.inputAmount).toBe('1000.5');
		expect(arg.allInCostBps).toBe('12.3');
		expect(arg.offchainPrice).toBeNull();
		// jsonb + non-numeric pass through unchanged
		expect(arg.routeLegs).toEqual([{ venue: '0xpool' }]);
		expect(arg.blockNumber).toBe(123);
		expect(arg.settlementEventSeen).toBe(true);
		expect(arg.fillerAddress).toBe('0xfiller1234567890abcdef1234567890abcdef12');
	});
});

// chainId was accepted as any integer and persisted verbatim, while core always
// analyzes Base regardless — so a row could claim chainId 1 while holding Base
// data. Verified against the real analyzer: 1, 999999, -1 and 0 all passed.
describe('POST /api/receipts — chainId validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		mockInsert.mockResolvedValue({ id: 1, txHash: VALID_HASH } as never);
		process.env.TCA_RPC_URL = 'http://rpc.test';
	});

	it.each([1, 999999, -1, 0, 1.5])('rejects unsupported chainId %s with 400', async (cid) => {
		const res = await POST(post({ hash: VALID_HASH, chainId: cid }));
		expect(res.status).toBe(400);
		expect(mockAnalyze).not.toHaveBeenCalled();
	});

	it('accepts the supported chain explicitly', async () => {
		expect((await POST(post({ hash: VALID_HASH, chainId: 8453 }))).status).toBe(200);
	});

	it('defaults to Base when chainId is omitted', async () => {
		expect((await POST(post({ hash: VALID_HASH }))).status).toBe(200);
		expect(mockAnalyze).toHaveBeenCalledWith(VALID_HASH, 8453, expect.anything());
	});

	// Rejecting before the RPC call matters: validation that runs after the
	// analysis would still have paid the ~40-call bill.
	it('rejects a bad chainId before spending any RPC', async () => {
		await POST(post({ hash: VALID_HASH, chainId: 42161 }));
		expect(mockAnalyze).not.toHaveBeenCalled();
		expect(mockGet).not.toHaveBeenCalled();
	});
});

// A malformed hash can never resolve to a transaction, so there is nothing to
// look up — rejecting it before the cache read (let alone the ~40-call RPC
// analysis) means garbage input costs nothing.
describe('POST /api/receipts — hash syntax validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		mockInsert.mockResolvedValue({ id: 1, txHash: VALID_HASH } as never);
		process.env.TCA_RPC_URL = 'http://rpc.test';
	});

	it.each([
		['too short', '0x1234'],
		['too long', VALID_HASH + 'a'],
		['missing 0x prefix', 'a'.repeat(64)],
		['uppercase X prefix', '0X' + 'a'.repeat(64)],
		['non-hex characters', '0x' + 'g'.repeat(64)],
		['internal whitespace', '0x' + 'a'.repeat(31) + ' ' + 'a'.repeat(32)],
	])('rejects a hash with %s with 400', async (_label, hash) => {
		const res = await POST(post({ hash }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid transaction hash.' });
	});

	it('rejects a bad hash before touching the cache or any RPC', async () => {
		await POST(post({ hash: '0xnotahash' }));
		expect(mockGet).not.toHaveBeenCalled();
		expect(mockAnalyze).not.toHaveBeenCalled();
	});

	it('accepts a well-formed hash', async () => {
		expect((await POST(post({ hash: VALID_HASH }))).status).toBe(200);
	});
});

// A fresh analysis costs ~40 RPC calls (measured); a cache hit costs one
// indexed DB read. Limiting them at the same rate would either throttle honest
// re-views or leave the expensive path wide open, so they are metered apart.
describe('POST /api/receipts — rate limiting', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.TCA_RPC_URL = 'http://rpc.test';
	});

	it('rate-limits fresh analyses well before a hundred requests', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		mockInsert.mockResolvedValue({ id: 1 } as never);
		const ip = '198.51.100.10';
		const codes: number[] = [];
		for (let i = 0; i < 100; i++) codes.push((await POST(postFrom(ip, { hash: VALID_HASH }))).status);
		expect(codes).toContain(429);
	});

	it('stops calling the analyzer once the analysis limit is hit', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		mockInsert.mockResolvedValue({ id: 1 } as never);
		const ip = '198.51.100.11';
		for (let i = 0; i < 100; i++) await POST(postFrom(ip, { hash: VALID_HASH }));
		expect(mockAnalyze.mock.calls.length).toBeLessThan(100);
	});

	it('sends retry-after on a 429 so a client can back off', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		mockInsert.mockResolvedValue({ id: 1 } as never);
		const ip = '198.51.100.12';
		let res: Response | undefined;
		for (let i = 0; i < 100; i++) res = await POST(postFrom(ip, { hash: VALID_HASH }));
		expect(res!.status).toBe(429);
		expect(Number(res!.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	// Cache hits are cheap, so they get a much higher ceiling than analyses —
	// but not an unlimited one, or a hot-hash loop is still a free DoS.
	it('allows far more cache hits than fresh analyses before limiting', async () => {
		mockGet.mockResolvedValue({ id: 7, txHash: VALID_HASH } as never);
		const ip = '198.51.100.13';
		let allowed = 0;
		for (let i = 0; i < 40; i++) {
			if ((await POST(postFrom(ip, { hash: VALID_HASH }))).status === 200) allowed++;
		}
		expect(allowed).toBe(40);
		expect(mockAnalyze).not.toHaveBeenCalled();
	});

	it('eventually limits cache hits too', async () => {
		mockGet.mockResolvedValue({ id: 7, txHash: VALID_HASH } as never);
		const ip = '198.51.100.14';
		const codes: number[] = [];
		for (let i = 0; i < 400; i++) codes.push((await POST(postFrom(ip, { hash: VALID_HASH }))).status);
		expect(codes).toContain(429);
	});
});

// DELETE is the one destructive endpoint: it was reachable by anyone, with no
// auth, no ownership check and no logging, so a trivial loop over ids wiped the
// corpus. Middleware now gates it, but middleware is one regex away from not
// matching — the handler re-checks rather than trusting the perimeter.
describe('DELETE /api/receipts — defence in depth', () => {
	const SECRET = 'session-secret-at-least-32-characters';

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APP_SESSION_SECRET = SECRET;
		process.env.APP_ACCESS_PASSWORD = 'pw';
	});
	afterEach(() => {
		delete process.env.APP_SESSION_SECRET;
		delete process.env.APP_ACCESS_PASSWORD;
	});

	const del = (url: string, cookie?: string) =>
		new Request(url, {
			method: 'DELETE',
			headers: {
				'x-forwarded-for': nextIp(),
				...(cookie ? { cookie } : {}),
			},
		});

	it('refuses to delete without a session', async () => {
		const res = await DELETE(del('http://x/api/receipts?id=1'));
		expect(res.status).toBe(401);
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('refuses a forged session cookie', async () => {
		const res = await DELETE(del('http://x/api/receipts?id=1', `${SESSION_COOKIE}=999999999999.forged`));
		expect(res.status).toBe(401);
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('deletes when a valid session is present', async () => {
		const token = await signSession(SECRET, Date.now() + 60_000);
		const res = await DELETE(del('http://x/api/receipts?id=5', `${SESSION_COOKIE}=${token}`));
		expect(res.status).toBe(204);
		expect(mockDelete).toHaveBeenCalledWith(5);
	});

	it('still validates the id for an authenticated caller', async () => {
		const token = await signSession(SECRET, Date.now() + 60_000);
		const res = await DELETE(del('http://x/api/receipts?id=abc', `${SESSION_COOKIE}=${token}`));
		expect(res.status).toBe(400);
		expect(mockDelete).not.toHaveBeenCalled();
	});
});

// Two concurrent POSTs for the same unseen hash both miss the cache and both
// analyze. That was previously invisible — the unique index was inert, so both
// simply inserted. Now the second insert violates the constraint, and the
// request must resolve to the row that won rather than 500.
describe('POST /api/receipts — concurrent insert of the same hash', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.TCA_RPC_URL = 'http://rpc.test';
		mockAnalyze.mockResolvedValue(sampleReceipt);
	});

	it('returns the winning row when the insert loses the race', async () => {
		const winner = { id: 99, txHash: VALID_HASH } as never;
		mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
		mockInsert.mockRejectedValue(
			Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
		);

		const res = await POST(post({ hash: VALID_HASH }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(winner);
	});

	it('surfaces a real insert failure rather than pretending it succeeded', async () => {
		mockGet.mockResolvedValue(null);
		mockInsert.mockRejectedValue(new Error('connection terminated'));

		const res = await POST(post({ hash: VALID_HASH }));

		expect(res.status).toBe(500);
	});
});
