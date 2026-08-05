import { describe, expect, it } from 'vitest';
import {
	extractEndpoints,
	perAddressTokenDeltas,
	cleanSwapFromNets,
	findCleanSwapCandidates,
	selectBeneficiary,
	detectBeneficiaryByNetFlow,
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

const TRANSFER2 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad2 = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const word2 = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as string;
const xfer2 = (token: string, from: string, to: string, value: bigint) => ({
	address: token,
	topics: [TRANSFER2, pad2(from), pad2(to)],
	data: word2(value),
});

const TKA = '0xaa00000000000000000000000000000000000001';
const TKB = '0xbb00000000000000000000000000000000000002';
const RELAYER2 = '0x1111111111111111111111111111111111111111'; // tx.from, zero net
const BENE_EOA = '0x2222222222222222222222222222222222222222';
const INTERMEDIARY = '0x3333333333333333333333333333333333333333';

describe('detectBeneficiaryByNetFlow', () => {
	// Beneficiary EOA sells TKA, gets TKB; an intermediary contract does the
	// mirror TKB->TKA hop. Two clean-swap addresses; EOA must win.
	const trace = { logs: [
		xfer2(TKA, BENE_EOA, INTERMEDIARY, 100n),
		xfer2(TKB, INTERMEDIARY, BENE_EOA, 90n),
		xfer2(TKA, INTERMEDIARY, '0x9999999999999999999999999999999999999999', 100n),
		xfer2(TKB, '0x9999999999999999999999999999999999999999', INTERMEDIARY, 90n),
	] };
	const isEoa = async (a: string) => a.toLowerCase() === BENE_EOA.toLowerCase();

	it('selects the EOA beneficiary, never the contract intermediary', async () => {
		const d = await detectBeneficiaryByNetFlow(trace as never, RELAYER2, isEoa);
		expect(d?.beneficiary.toLowerCase()).toBe(BENE_EOA.toLowerCase());
		expect(d?.inputToken.toLowerCase()).toBe(TKA);
		expect(d?.outputToken.toLowerCase()).toBe(TKB);
	});

	it('fails closed to null when two contract candidates are ambiguous', async () => {
		const d = await detectBeneficiaryByNetFlow(trace as never, RELAYER2, async () => false);
		expect(d).toBeNull();
	});
});

// ─── Frame types that do not move ETH ───
//
// geth's callTracer repeats the inherited `msg.value` on DELEGATECALL /
// CALLCODE frames, but those execute in the CALLER's balance context — no ETH
// moves. Counting them debits the receiving account and credits the
// implementation, which silently reroutes the credit. An EIP-7702 delegated EOA
// hits this on every native-ETH payout (real case: Relay tx 0x92541bad…).
describe('collectNativeEthDeltas frame types', () => {
	const EOA_7702 = '0x000000000000000000000000000000000000d00d';
	const IMPL = '0x00000000000000000000000000000000000de1e6';
	const PAYER = '0x0000000000000000000000000000000000c0c0c0';
	const WEI = 1554680041161137n;

	/** Payer sends TOKEN_A in; EOA is paid native ETH, then re-enters `impl`
	 *  via `innerType`, which the tracer stamps with the same inherited value. */
	const traceWith = (innerType: string) => ({
		type: 'CALL',
		from: EOA_7702,
		to: PAYER,
		value: '0x0',
		logs: [{ address: TOKEN_A, topics: [TRANSFER, pad(EOA_7702), pad(PAYER)], data: hex(1000n) }],
		calls: [
			{
				type: 'CALL',
				from: PAYER,
				to: EOA_7702,
				value: '0x' + WEI.toString(16),
				calls: [{ type: innerType, from: EOA_7702, to: IMPL, value: '0x' + WEI.toString(16), calls: [] }],
			},
		],
	});

	it.each(['DELEGATECALL', 'CALLCODE'])(
		'%s does not move the native credit off the receiving account',
		(innerType) => {
			const per = perAddressTokenDeltas(traceWith(innerType) as never);
			expect(per.get(EOA_7702)?.get('native')).toBe(WEI);
			expect(per.get(IMPL)?.get('native') ?? 0n).toBe(0n);
		},
	);

	it('still counts a real value-bearing CALL', () => {
		const per = perAddressTokenDeltas(traceWith('CALL') as never);
		expect(per.get(IMPL)?.get('native')).toBe(WEI);
		// EOA nets to zero here (received then forwarded); zero nets are not stored.
		expect(per.get(EOA_7702)?.get('native') ?? 0n).toBe(0n);
	});

	it('a 7702 EOA paid in native ETH resolves as a clean swap', () => {
		const e = extractEndpoints({ trace: traceWith('DELEGATECALL') as never, trader: EOA_7702 });
		expect(e?.inputToken).toBe(TOKEN_A);
		expect(e?.outputToken).toBe('native');
		expect(e?.inputAmountRaw).toBe(1000n);
		expect(e?.outputAmountRaw).toBe(WEI);
	});
});
