import { describe, expect, it } from 'vitest';
import {
	extractEndpoints,
	perAddressTokenDeltas,
	cleanSwapFromNets,
	findCleanSwapCandidates,
	selectBeneficiary,
	type CleanSwap,
} from './endpoints.js';

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

// Minimal callTracer log helper: an ERC-20 Transfer(from,to,value). Reuses
// the module-level TRANSFER/pad/hex helpers above (same shape as the task
// brief's standalone `word`/`pad`, renamed here only to avoid redeclaring
// consts already defined at the top of this file).
function transferLog(token: string, from: string, to: string, value: bigint) {
	return { address: token, data: hex(value), topics: [TRANSFER, pad(from), pad(to)] };
}

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const P = '0x' + 'c'.repeat(40); // pool
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';

describe('perAddressTokenDeltas', () => {
	it('sums signed per-address token deltas across a trace', () => {
		const trace = {
			logs: [transferLog(WETH, A, P, 100n), transferLog(USDC, P, A, 250n)],
			calls: [],
		} as never;
		const per = perAddressTokenDeltas(trace);
		expect(per.get(A.toLowerCase())!.get(WETH)).toBe(-100n);
		expect(per.get(A.toLowerCase())!.get(USDC)).toBe(250n);
		expect(per.get(P.toLowerCase())!.get(WETH)).toBe(100n);
		expect(per.get(P.toLowerCase())!.get(USDC)).toBe(-250n);
	});
});

describe('cleanSwapFromNets', () => {
	it('returns input=negative leg, output=positive leg for a clean 1-in/1-out', () => {
		const nets = new Map<string, bigint>([[WETH, -100n], [USDC, 250n]]);
		expect(cleanSwapFromNets(nets)).toEqual({
			inputToken: WETH, outputToken: USDC, inputAmountRaw: 100n, outputAmountRaw: 250n,
		});
	});
	it('ignores zero-net tokens', () => {
		const nets = new Map<string, bigint>([[WETH, -100n], [USDC, 250n], ['0xdead', 0n]]);
		expect(cleanSwapFromNets(nets)?.inputToken).toBe(WETH);
	});
	it('returns null when not exactly 1 negative and 1 positive', () => {
		expect(cleanSwapFromNets(new Map([[WETH, -100n]]))).toBeNull();
		expect(cleanSwapFromNets(new Map([[WETH, -1n], [USDC, -2n], ['0xx', 3n]]))).toBeNull();
	});
});

const RELAYER = '0x' + 'f'.repeat(40); // tx.from, nets nothing

describe('findCleanSwapCandidates', () => {
	it('finds beneficiary + counterparty; relayer (net zero) absent', () => {
		// A = beneficiary: WETH out(-100), USDC in(+250). P = counterparty: mirror.
		const trace = {
			logs: [transferLog(WETH, A, P, 100n), transferLog(USDC, P, A, 250n)],
			calls: [],
		} as never;
		const cands = findCleanSwapCandidates(trace, RELAYER);
		const addrs = cands.map((c) => c.address).sort();
		expect(addrs).toEqual([A.toLowerCase(), P.toLowerCase()].sort());
	});

	it('returns [] for a non-swap (single one-sided transfer)', () => {
		const trace = { logs: [transferLog(USDC, A, B, 50n)], calls: [] } as never;
		expect(findCleanSwapCandidates(trace, RELAYER)).toEqual([]);
	});
});

describe('selectBeneficiary', () => {
	const eoaAddr = A.toLowerCase();
	const contractAddr = P.toLowerCase();
	const candA: CleanSwap = { address: eoaAddr, inputToken: USDC, outputToken: 'native', inputAmountRaw: 1n, outputAmountRaw: 2n };
	const candP: CleanSwap = { address: contractAddr, inputToken: WETH, outputToken: USDC, inputAmountRaw: 3n, outputAmountRaw: 4n };

	it('prefers the sole EOA among candidates', () => {
		const isEoa = (a: string) => a === eoaAddr;
		expect(selectBeneficiary([candA, candP], RELAYER, isEoa)).toEqual({
			beneficiary: eoaAddr, inputToken: USDC, outputToken: 'native',
		});
	});

	it('falls back to the sole candidate when none are EOA (AA wallet)', () => {
		expect(selectBeneficiary([candP], RELAYER, () => false)).toEqual({
			beneficiary: contractAddr, inputToken: WETH, outputToken: USDC,
		});
	});

	it('returns null when two EOAs are ambiguous', () => {
		expect(selectBeneficiary([candA, candP], RELAYER, () => true)).toBeNull();
	});

	it('returns null for empty candidates', () => {
		expect(selectBeneficiary([], RELAYER, () => true)).toBeNull();
	});

	it('excludes the trader from selection', () => {
		const traderCand: CleanSwap = { ...candA, address: RELAYER.toLowerCase() };
		expect(selectBeneficiary([traderCand], RELAYER, () => true)).toBeNull();
	});
});
