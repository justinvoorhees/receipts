import { describe, expect, it } from 'vitest';
import {
	CHAINS,
	DEFAULT_CHAIN,
	chainById,
	explorerAddress,
	explorerTx,
	resolveChainParam,
} from './chains';

describe('chain registry', () => {
	it('defaults to Base', () => {
		expect(DEFAULT_CHAIN.id).toBe(8453);
		expect(DEFAULT_CHAIN.slug).toBe('base');
		expect(DEFAULT_CHAIN.name).toBe('Base');
	});

	it('resolves a canonical slug', () => {
		expect(resolveChainParam('base')).toEqual({ chain: DEFAULT_CHAIN, canonical: true });
	});

	it('resolves a mis-cased slug as NON-canonical so the caller redirects', () => {
		expect(resolveChainParam('BASE')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
		expect(resolveChainParam('Base')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
	});

	it('resolves the numeric id as a NON-canonical alias', () => {
		expect(resolveChainParam('8453')).toEqual({ chain: DEFAULT_CHAIN, canonical: false });
	});

	it('rejects unregistered slugs and ids', () => {
		expect(resolveChainParam('arbitrum')).toBeNull();
		expect(resolveChainParam('1')).toBeNull();
		expect(resolveChainParam('42161')).toBeNull();
		expect(resolveChainParam('')).toBeNull();
	});

	// A hex chain id would be a second spelling of the same thing, and the API
	// contract at app/api/receipts/route.ts takes a JSON number. Decimal only.
	it('rejects a hex-spelled chain id', () => {
		expect(resolveChainParam('0x2105')).toBeNull();
	});

	it('looks a chain up by id', () => {
		expect(chainById(8453)).toEqual(DEFAULT_CHAIN);
		expect(chainById(1)).toBeNull();
	});

	it('builds explorer URLs', () => {
		expect(explorerTx(DEFAULT_CHAIN, '0xabc')).toBe('https://basescan.org/tx/0xabc');
		expect(explorerAddress(DEFAULT_CHAIN, '0xdef')).toBe('https://basescan.org/address/0xdef');
	});
});

// ─── Tripwire ────────────────────────────────────────────────────────────────
// This test is SUPPOSED to fail when someone adds a chain. That is its entire
// purpose. Read the failure message, pay the two debts it names, then update
// the expected length. Do not delete it.
describe('single-chain assumptions', () => {
	it('has exactly one registered chain', () => {
		expect(
			CHAINS.length,
			[
				'A second chain was added. Two things are now silently WRONG and must be fixed in this same change:',
				'',
				'  1. lib/queries.ts getReceiptByHash() matches on lower(tx_hash) alone and ignores chain_id,',
				'     even though the unique key is (user_id, tx_hash, chain_id). Two chains sharing a tx hash',
				'     are interchangeable to it. Add a chainId parameter and filter on it.',
				'',
				'  2. The 8 explorer links in receiptView.tsx, receipt/receiptDisplay.tsx and',
				'     receipt/receiptRows.tsx pass DEFAULT_CHAIN, not the row’s own chain. They will point',
				'     at Basescan for every chain. Thread the real chain through.',
				'',
				'See docs/superpowers/specs/2026-08-06-multichain-urls-design.md §2 and §3.',
			].join('\n'),
		).toBe(1);
	});
});
