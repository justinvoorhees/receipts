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

	// One unanalyzable hash in a list of ten must not cost the other nine. This
	// covers the case where loadReceipt resolves null (a decodable-but-not-a-swap
	// transaction) — see the next test for the case where it throws.
	it('isolates a failing hash to its own row', async () => {
		loadReceipt.mockImplementation(async (_c: unknown, h: string) =>
			h === A ? { txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 } : null,
		);
		const html = renderToString(await QaPage({ params: paramsFor(`${A},${B}`) }));
		expect(html).toContain('USDC');
		expect(html).toContain('no receipt');
	});

	// The try/catch around loadReceipt is the mechanism, not just the null branch:
	// loadReceipt genuinely throws (missing TCA_RPC_URL, or anything
	// analyzeTransaction raises), and one throw must not sink the other rows.
	it('isolates a hash whose analysis throws to its own row, without losing the rest', async () => {
		loadReceipt.mockImplementation(async (_c: unknown, h: string) => {
			if (h === A) return { txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 };
			throw new Error('RPC exploded');
		});
		const html = renderToString(await QaPage({ params: paramsFor(`${A},${B}`) }));
		expect(html).toContain('USDC');
		expect(html).toContain('no receipt');
	});

	it('rejects a malformed hash without spending an analysis', async () => {
		await expect(QaPage({ params: paramsFor('0xnope') })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	// Verified against a live dev server: Next 15's App Router re-encodes a
	// literal ',' in this dynamic segment into the literal string '%2C' by the
	// time it reaches the page (ordinary %XX sequences decode fine — only the
	// separator itself doesn't survive as a raw comma). Without decoding, this
	// never splits and the whole thing fails HASH_RE as one blob — the primary
	// two-hash-comparison URL shape wouldn't work at all.
	it('decodes a %2C-separated hash list back into two hashes (Next hands the page an encoded separator, not a raw comma)', async () => {
		loadReceipt.mockResolvedValue({ txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 });
		await QaPage({ params: paramsFor(`${A}%2C${B}`) });
		expect(loadReceipt).toHaveBeenCalledTimes(2);
	});

	// decodeURIComponent throws URIError on a malformed sequence (a bare '%').
	// That must resolve to notFound(), not an unhandled throw past this
	// function — decoding is necessary (see the test above) but has to be safe.
	it('rejects a percent-malformed hash param without throwing past notFound', async () => {
		await expect(QaPage({ params: paramsFor('%') })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	it('404s on an unknown chain', async () => {
		await expect(QaPage({ params: Promise.resolve({ chain: 'solana', hashes: A }) }))
			.rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});
});
