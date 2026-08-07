import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createNotifier,
	ceilingReachedMessage,
	budgetWarningMessage,
	receiptCreatedMessage,
	originFrom,
	baseUrlFrom,
	baseUrlFromHeaders,
} from './alerts';

/** A controllable clock, matching the pattern in rateLimit.test.ts. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const okFetch = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

describe('createNotifier', () => {
	it('posts the message to the webhook', async () => {
		const fetchImpl = okFetch();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl });
		await notify('receipt_created', 'hello');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe('https://hook.test/x');
		expect(JSON.parse(init!.body as string)).toEqual({ text: 'hello', content: 'hello' });
	});

	it('does not fetch when no webhook url is configured', async () => {
		const fetchImpl = okFetch();
		const log = vi.fn();
		const notify = createNotifier({ fetchImpl, log });
		await notify('ceiling_reached', 'nobody is listening');
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalled();
	});

	it('never rejects when the webhook fails', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
		const log = vi.fn();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl, log });
		await expect(notify('ceiling_reached', 'boom')).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	});

	it('suppresses a second message of the same kind inside the debounce window', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'first');
		clock.advance(30_000);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('sends again once the debounce window has elapsed', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'first');
		clock.advance(60_001);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('debounces each kind independently', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'a');
		await notify('budget_warning', 'b');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	// The activity stream must NOT debounce, or a launch-day burst of real
	// receipts would silently report only the first one.
	it('sends every message when debouncing is disabled', async () => {
		const fetchImpl = okFetch();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl });
		await notify('receipt_created', 'one');
		await notify('receipt_created', 'two');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	// A transient outage must not blank the next genuine incident of the same kind.
	it('does not consume the debounce window when the send fails', async () => {
		const clock = fakeClock();
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000, log: () => {},
		});
		await notify('ceiling_reached', 'first');
		clock.advance(1_000);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	// A dead webhook must not look like a working one.
	it('treats a non-2xx response as a failure', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404, statusText: 'Not Found' }));
		const log = vi.fn();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl, log });
		await expect(notify('ceiling_reached', 'boom')).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
		expect(String(log.mock.calls[0]![0])).toContain('404');
	});

	it('does not consume the debounce window on a non-2xx response', async () => {
		const clock = fakeClock();
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Server Error' }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000, log: () => {},
		});
		await notify('ceiling_reached', 'first');
		clock.advance(1_000);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not reject when the injected logger throws', async () => {
		const log = vi.fn(() => { throw new Error('logger exploded'); });
		const notify = createNotifier({ log });
		await expect(notify('ceiling_reached', 'no url configured')).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	});
});

describe('message formatting', () => {
	it('names the limit and the pause in the ceiling message', () => {
		const msg = ceilingReachedMessage(500, 900);
		expect(msg).toContain('500');
		expect(msg).toContain('15 min');
	});

	it('reports consumed and remaining in the warning message', () => {
		const msg = budgetWarningMessage(500, 100);
		expect(msg).toContain('400/500');
		expect(msg).toContain('100');
	});

	it('summarises a receipt and links to it', () => {
		const msg = receiptCreatedMessage(
			{
				txHash: '0xdead',
				aggregator: '0x',
				inputSymbol: 'WETH',
				outputSymbol: 'USDC',
				notionalUsd: 4210.44,
				allInCostBps: 12.37,
			},
			'https://app.test',
		);
		expect(msg).toContain('WETH');
		expect(msg).toContain('USDC');
		expect(msg).toContain('0x');
		expect(msg).toContain('$4210');
		expect(msg).toContain('12.4 bps');
		expect(msg).toContain('https://app.test/tx/base/0xdead');
	});

	it('tolerates a receipt with nothing resolved', () => {
		const msg = receiptCreatedMessage(
			{
				txHash: '0xbeef', aggregator: null, inputSymbol: null,
				outputSymbol: null, notionalUsd: null, allInCostBps: null,
			},
			'https://app.test',
		);
		expect(msg).toContain('https://app.test/tx/base/0xbeef');
		expect(msg).not.toContain('null');
	});

	it('renders a genuinely zero all-in cost, not a blank segment (0 is falsy, absence is null)', () => {
		// Regression: notionalUsd/allInCostBps used to arrive as Drizzle strings,
		// where '0' is truthy. Now that ReceiptSummary is number | null, a truthy
		// guard would silently drop a real zero-cost execution's "bps all-in"
		// segment — indistinguishable from a receipt where the cost was never
		// resolved at all. Must check != null, not truthiness.
		const msg = receiptCreatedMessage(
			{
				txHash: '0xzero',
				aggregator: '0x',
				inputSymbol: 'WETH',
				outputSymbol: 'USDC',
				notionalUsd: 0,
				allInCostBps: 0,
			},
			'https://app.test',
		);
		expect(msg).toContain('$0');
		expect(msg).toContain('0.0 bps all-in');
	});
});

describe('originFrom', () => {
	it('uses the forwarded protocol behind a proxy', () => {
		const req = new Request('http://internal/api/receipts', {
			headers: { host: 'app.up.railway.app', 'x-forwarded-proto': 'https' },
		});
		expect(originFrom(req)).toBe('https://app.up.railway.app');
	});

	it('falls back to http for localhost', () => {
		const req = new Request('http://internal/api/receipts', { headers: { host: 'localhost:3000' } });
		expect(originFrom(req)).toBe('http://localhost:3000');
	});
});

describe('baseUrlFrom', () => {
	const originalEnv = process.env.APP_BASE_URL;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.APP_BASE_URL;
		else process.env.APP_BASE_URL = originalEnv;
	});

	// The request's Host header is attacker-controlled on this public endpoint;
	// APP_BASE_URL must win so a forged Host can't land a phishing link in Slack.
	it('prefers APP_BASE_URL over a hostile Host header', () => {
		process.env.APP_BASE_URL = 'https://app.example.com';
		const req = new Request('http://internal/api/receipts', {
			headers: { host: 'evil.com', 'x-forwarded-proto': 'https' },
		});
		expect(baseUrlFrom(req)).toBe('https://app.example.com');
	});

	it('falls back to originFrom when APP_BASE_URL is unset', () => {
		delete process.env.APP_BASE_URL;
		const req = new Request('http://internal/api/receipts', {
			headers: { host: 'app.up.railway.app', 'x-forwarded-proto': 'https' },
		});
		expect(baseUrlFrom(req)).toBe('https://app.up.railway.app');
	});
});

describe('baseUrlFromHeaders', () => {
	const originalEnv = process.env.APP_BASE_URL;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.APP_BASE_URL;
		else process.env.APP_BASE_URL = originalEnv;
	});

	// Same property as baseUrlFrom, for the Headers-holding caller (a server
	// component): a forged Host header must not win over APP_BASE_URL, or a
	// visitor could land a phishing link in the team's own Slack.
	it('prefers APP_BASE_URL over a hostile Host header', () => {
		process.env.APP_BASE_URL = 'https://app.example.com';
		const h = new Headers({ host: 'evil.com', 'x-forwarded-proto': 'https' });
		expect(baseUrlFromHeaders(h)).toBe('https://app.example.com');
	});

	it('falls back to the derived origin when APP_BASE_URL is unset', () => {
		delete process.env.APP_BASE_URL;
		const h = new Headers({ host: 'app.up.railway.app', 'x-forwarded-proto': 'https' });
		expect(baseUrlFromHeaders(h)).toBe('https://app.up.railway.app');
	});

	it('falls back to http for localhost with no configured URL', () => {
		delete process.env.APP_BASE_URL;
		const h = new Headers({ host: 'localhost:3000' });
		expect(baseUrlFromHeaders(h)).toBe('http://localhost:3000');
	});
});
