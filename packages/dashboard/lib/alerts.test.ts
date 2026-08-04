import { describe, it, expect, vi } from 'vitest';
import {
	createNotifier,
	ceilingReachedMessage,
	budgetWarningMessage,
	receiptCreatedMessage,
	originFrom,
} from './alerts';

/** A controllable clock, matching the pattern in rateLimit.test.ts. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const okFetch = () => vi.fn(async () => new Response(null, { status: 200 }));

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
				notionalUsd: '4210.44',
				allInCostBps: '12.37',
			},
			'https://app.test',
		);
		expect(msg).toContain('WETH');
		expect(msg).toContain('USDC');
		expect(msg).toContain('0x');
		expect(msg).toContain('$4210');
		expect(msg).toContain('12.4 bps');
		expect(msg).toContain('https://app.test/?tx=0xdead');
	});

	it('tolerates a receipt with nothing resolved', () => {
		const msg = receiptCreatedMessage(
			{
				txHash: '0xbeef', aggregator: null, inputSymbol: null,
				outputSymbol: null, notionalUsd: null, allInCostBps: null,
			},
			'https://app.test',
		);
		expect(msg).toContain('https://app.test/?tx=0xbeef');
		expect(msg).not.toContain('null');
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
