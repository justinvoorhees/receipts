import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';

// This project's tsconfig uses "jsx": "preserve" with no automatic-runtime
// injection under vitest's esbuild transform, so JSX needs React in scope at
// module-eval time — same fix as app/tx/[chain]/[hash]/page.test.tsx.
globalThis.React = React;

const loadReceipt = vi.fn();
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); });

vi.mock('../../../../../lib/loadReceipt', () => ({ loadReceipt: (...a: unknown[]) => loadReceipt(...a) }));
vi.mock('next/navigation', () => ({ notFound }));

const QaPage = (await import('./page')).default;

const A = `0x${'a'.repeat(64)}`;
const B = `0x${'b'.repeat(64)}`;
const paramsFor = (hashes: string) => Promise.resolve({ chain: 'base', hashes });
const ORIGINAL_ENV = process.env.NODE_ENV;

// next/types/global.d.ts types NODE_ENV readonly ('development' | 'production'
// | 'test'), which is correct for app code but blocks a test from flipping it.
// This cast is the narrow escape hatch — everywhere else in the file it stays
// the readonly union.
const setNodeEnv = (value: string) => {
	(process.env as { NODE_ENV: string }).NODE_ENV = value;
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => setNodeEnv(ORIGINAL_ENV));

describe('/qa/tx/[chain]/[hashes]', () => {
	// The ONLY thing between a public URL and an unmetered n x 40 RPC call.
	it('404s in production without analyzing anything', async () => {
		setNodeEnv('production');
		await expect(QaPage({ params: paramsFor(`${A},${B}`) })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	it('loads every hash in the comma-separated list', async () => {
		loadReceipt.mockResolvedValue({ txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 });
		await QaPage({ params: paramsFor(`${A},${B}`) });
		expect(loadReceipt).toHaveBeenCalledTimes(2);
	});

	// One unanalyzable hash in a list of ten must not cost the other nine.
	it('isolates a failing hash to its own row', async () => {
		loadReceipt.mockImplementation(async (_c: unknown, h: string) =>
			h === A ? { txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 } : null,
		);
		const html = renderToString(await QaPage({ params: paramsFor(`${A},${B}`) }));
		expect(html).toContain('USDC');
		expect(html).toContain('no receipt');
	});

	it('rejects a malformed hash without spending an analysis', async () => {
		await expect(QaPage({ params: paramsFor('0xnope') })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	it('404s on an unknown chain', async () => {
		await expect(QaPage({ params: Promise.resolve({ chain: 'solana', hashes: A }) }))
			.rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});
});
