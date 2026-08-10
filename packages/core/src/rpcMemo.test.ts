import { describe, it, expect } from 'vitest';
import { memoizeRequest } from './rpcMemo.js';

/** A request function that records every call it actually receives. */
function countingRequest(handler?: (args: { method: string; params?: unknown }) => unknown) {
	const seen: string[] = [];
	const fn = async (args: { method: string; params?: unknown }) => {
		seen.push(`${args.method}:${JSON.stringify(args.params ?? [])}`);
		const r = handler ? handler(args) : 'ok';
		if (r instanceof Error) throw r;
		return r;
	};
	return { fn, seen };
}

describe('memoizeRequest', () => {
	it('serves a repeated identical request from the memo, reaching the transport once', async () => {
		const { fn, seen } = countingRequest();
		const memoized = memoizeRequest(fn, new Map());

		const a = await memoized({ method: 'eth_call', params: [{ to: '0xabc', data: '0x1698ee82' }, 'latest'] });
		const b = await memoized({ method: 'eth_call', params: [{ to: '0xabc', data: '0x1698ee82' }, 'latest'] });

		expect(a).toBe('ok');
		expect(b).toBe('ok');
		expect(seen).toHaveLength(1);
	});

	it('collapses concurrent identical requests into one in-flight call', async () => {
		const { fn, seen } = countingRequest();
		const memoized = memoizeRequest(fn, new Map());

		await Promise.all([
			memoized({ method: 'eth_call', params: ['x'] }),
			memoized({ method: 'eth_call', params: ['x'] }),
			memoized({ method: 'eth_call', params: ['x'] }),
		]);

		expect(seen).toHaveLength(1);
	});

	it('does not conflate different params or different methods', async () => {
		const { fn, seen } = countingRequest();
		const memoized = memoizeRequest(fn, new Map());

		await memoized({ method: 'eth_call', params: [{ to: '0xabc' }, '0x10'] });
		await memoized({ method: 'eth_call', params: [{ to: '0xabc' }, '0x11'] });
		await memoized({ method: 'eth_getCode', params: [{ to: '0xabc' }, '0x10'] });

		expect(seen).toHaveLength(3);
	});

	it('never memoizes a rejection — the next identical call retries the transport', async () => {
		let attempt = 0;
		const { fn, seen } = countingRequest(() => {
			attempt += 1;
			return attempt === 1 ? new Error('transient') : 'recovered';
		});
		const memoized = memoizeRequest(fn, new Map());

		await expect(memoized({ method: 'eth_call', params: ['x'] })).rejects.toThrow('transient');
		await expect(memoized({ method: 'eth_call', params: ['x'] })).resolves.toBe('recovered');

		expect(seen).toHaveLength(2);
	});

	it('leaves state-changing and subscription methods unmemoized', async () => {
		const { fn, seen } = countingRequest();
		const memoized = memoizeRequest(fn, new Map());

		await memoized({ method: 'eth_sendRawTransaction', params: ['0xdead'] });
		await memoized({ method: 'eth_sendRawTransaction', params: ['0xdead'] });

		expect(seen).toHaveLength(2);
	});

	it('scopes the memo to the map it is given, so two decodes never share results', async () => {
		const { fn, seen } = countingRequest();
		const requestA = memoizeRequest(fn, new Map());
		const requestB = memoizeRequest(fn, new Map());

		await requestA({ method: 'eth_call', params: ['x'] });
		await requestB({ method: 'eth_call', params: ['x'] });

		expect(seen).toHaveLength(2);
	});
});
