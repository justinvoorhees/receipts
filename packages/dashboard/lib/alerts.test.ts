import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createNotifier,
	ceilingReachedMessage,
	budgetWarningMessage,
	receiptCreatedMessage,
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
		// The pair leads AND carries the link — one scannable line, no bare URL on
		// a second. Asserted as the whole opening construct rather than the URL
		// and the pair separately, which would pass even if they came apart.
		expect(msg.startsWith('<https://app.test/tx/base/0xdead|WETH → USDC>')).toBe(true);
		expect(msg).toContain('0x');
		expect(msg).toContain('$4210');
		expect(msg).toContain('12.4bps');
		// Single line: the link is inline, so nothing should follow a newline.
		expect(msg).not.toContain('\n');
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
		// guard would silently drop a real zero-cost execution's bps segment —
		// indistinguishable from a receipt where the cost was never resolved at
		// all. Must check != null, not truthiness.
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
		expect(msg).toContain('0.0bps');
	});

	it('cannot be broken out of by a hostile token symbol', () => {
		// inputSymbol/outputSymbol come from symbol() on an arbitrary contract, so
		// their content is chosen by whoever deployed the token. Interpolated raw
		// into `<url|label>`, the symbol below closes our link and opens its own —
		// posting a link that reads one way and navigates another, into our Slack,
		// from our bot. The escaping is what stops that, so it needs a test that
		// actually attempts the break-out rather than one asserting a tidy input.
		const msg = receiptCreatedMessage(
			{
				txHash: '0xevil',
				aggregator: 'R&D',
				inputSymbol: '<https://evil.example|CLICK>',
				outputSymbol: 'USDC',
				notionalUsd: 1,
				allInCostBps: 1,
			},
			'https://app.test',
		);

		// The destination is ours, and the separator follows it immediately — so
		// nothing the symbol contains can reach the URL half of the construct.
		expect(msg.startsWith('<https://app.test/tx/base/0xevil|')).toBe(true);

		// Exactly one link construct in the whole message. Counting delimiters is
		// what proves the break-out failed: an unescaped symbol yields three of
		// each, and every assertion above would still pass.
		expect(msg.match(/</g)).toHaveLength(1);
		expect(msg.match(/>/g)).toHaveLength(1);

		// The hostile markup survives as visible text, not as markup.
		expect(msg).toContain('&lt;https://evil.example|CLICK&gt;');
		// & escaped first, so the entities above are not themselves re-escaped.
		expect(msg).toContain('R&amp;D');
		expect(msg).not.toContain('&amp;lt;');
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
