import { describe, expect, it } from 'vitest';
import { extractEndpoints } from './endpoints.js';

// Same synthetic-Transfer-log pattern as normalizeSmokeTrade.test.ts: real
// topic0 (keccak256 of Transfer(address,address,uint256)), 32-byte padded
// indexed addresses, 32-byte big-endian amount as data — exactly what
// decodeTransferLogs (tradeEndpoints.ts) expects.
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const trader = '0x000000000000000000000000000000000000d00d';
const TOKEN_A = '0x000000000000000000000000000000000000a1a1';
const TOKEN_B = '0x000000000000000000000000000000000000b2b2';
const COUNTERPARTY = '0x0000000000000000000000000000000000c0c0c0';

const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

// Trader sends 1000 raw TOKEN_A out, receives 5 raw TOKEN_B in.
const trace = {
	logs: [
		{ address: TOKEN_A, topics: [TRANSFER, pad(trader), pad(COUNTERPARTY)], data: hex(1000n) },
		{ address: TOKEN_B, topics: [TRANSFER, pad(COUNTERPARTY), pad(trader)], data: hex(5n) },
	],
	calls: [],
};

describe('extractEndpoints', () => {
	it('picks the most-negative and most-positive net tokens as in/out', () => {
		const e = extractEndpoints({ trace: trace as never, trader });
		expect(e?.inputToken).toBe(TOKEN_A);
		expect(e?.outputToken).toBe(TOKEN_B);
		expect(e?.inputAmountRaw).toBe(1000n);
		expect(e?.outputAmountRaw).toBe(5n);
		expect(e?.trader).toBe(trader);
	});

	it('returns null when trader has no clean 2-token flow (no logs)', () => {
		expect(extractEndpoints({ trace: { logs: [] } as never, trader })).toBeNull();
	});

	it('returns null when a third token muddies the trader net (not a clean 2-token flow)', () => {
		const TOKEN_C = '0x000000000000000000000000000000000000c3c3';
		const dirtyTrace = {
			logs: [
				...trace.logs,
				// trader also receives TOKEN_C — three nonzero-net tokens, not clean.
				{ address: TOKEN_C, topics: [TRANSFER, pad(COUNTERPARTY), pad(trader)], data: hex(7n) },
			],
			calls: [],
		};
		expect(extractEndpoints({ trace: dirtyTrace as never, trader })).toBeNull();
	});

	it('folds native ETH into the net via collectNativeEthDeltas, using "native" as the token key', () => {
		// Trader sends 1000 raw TOKEN_A out (ERC-20 log) and receives 2000 wei
		// native ETH in (the call itself carries `value`, per callTracer shape).
		const nativeTrace = {
			from: COUNTERPARTY,
			to: trader,
			value: '0x' + (2000).toString(16),
			logs: [
				{ address: TOKEN_A, topics: [TRANSFER, pad(trader), pad(COUNTERPARTY)], data: hex(1000n) },
			],
			calls: [],
		};
		const e = extractEndpoints({ trace: nativeTrace as never, trader });
		expect(e?.inputToken).toBe(TOKEN_A);
		expect(e?.outputToken).toBe('native');
		expect(e?.inputAmountRaw).toBe(1000n);
		expect(e?.outputAmountRaw).toBe(2000n);
	});
});
