import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { classifyTransaction } from './classifyTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const d = RPC ? describe : describe.skip;

describe('classifyTransaction format check (no RPC)', () => {
	it('flags a malformed hash as INVALID_HASH', async () => {
		const r = await classifyTransaction('0x123', 8453, { rpcUrl: 'http://unused' });
		expect(r.reason).toBe('INVALID_HASH');
	});

	it('maps an unreachable RPC to ANALYZE_ERROR, not NOT_FOUND_ONCHAIN', async () => {
		// Well-formed hash, but the node refuses the connection: an infra failure
		// must not masquerade as "transaction does not exist".
		const r = await classifyTransaction('0x' + '1'.repeat(64), 8453, { rpcUrl: 'http://127.0.0.1:1' });
		expect(r.reason).toBe('ANALYZE_ERROR');
	}, 30000);
});

d('classifyTransaction e2e', () => {
	it('reports an anchored account with no clean 2-token flow as RELAYER_THIRD_PARTY', async () => {
		// An ERC-4337 transaction with NO bridge markers. resolveTrader anchors the
		// smart account authoritatively, but that account does not net a clean
		// token-in/token-out pair, so analyzeTransaction misses and net-flow names a
		// different sole beneficiary. This is the only shape that still reaches this
		// reason: a miss that fell through to tier 4 would have produced a receipt.
		const r = await classifyTransaction(
			'0xe4e163e2f5e9d3957543c8819a5d966b498f5a7a510636fc6f925bf8f141bae4',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r.reason).toBe('RELAYER_THIRD_PARTY');
		expect(r.detail?.beneficiary.toLowerCase()).toBe('0xd0b53d9277642d899df5c87a3966a349a798f224');
		// USDC in, WETH out.
		expect(r.detail?.inputToken.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
		expect(r.detail?.outputToken.toLowerCase()).toBe('0x4200000000000000000000000000000000000006');
	}, 60000);

	it('prefers CROSS_CHAIN_LEG over RELAYER_THIRD_PARTY when a bridge marker is present', async () => {
		// This hash previously pinned RELAYER_THIRD_PARTY with Relay's solver
		// (0xf70da978…) as the detected beneficiary. It is a Relay cross-chain leg,
		// so the bridge's own declaration now wins over the net-flow heuristic —
		// and no detail is claimed, because which side this leg is was not decoded.
		const r = await classifyTransaction(
			'0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r.reason).toBe('CROSS_CHAIN_LEG');
		expect(r.detail).toBeUndefined();
	}, 60000);

	it('returns NOT_FOUND_ONCHAIN for a well-formed but absent hash', async () => {
		const r = await classifyTransaction('0x' + '0'.repeat(64), 8453, { rpcUrl: RPC! });
		expect(r.reason).toBe('NOT_FOUND_ONCHAIN');
	}, 60000);

	// Relay cross-chain legs. Only one side of each trade is on Base, so no
	// address nets a clean token-in/token-out pair and the generic answer was
	// NOT_DECODABLE ("Not a swap") — false for the origin legs below, which do
	// swap on Base before bridging the output onward.
	//
	// Two shapes, both cross-chain:
	//   destination fill — Relay's solver funds the input, the user receives
	//   origin leg       — the user funds the input, the output is bridged away
	it.each([
		['destination fill (cbBTC in from solver, PRE out to recipient)', '0x31ccbe0a24da8a44c6f66361a41f278493e59a5508a5612e1c7573ff5b2bd62d'],
		['origin leg that swaps first (RUSSELL -> WETH -> USDC, then deposited)', '0x1f1b09ca36e521855f72e5cedadbcf0d94a6631d505ef5ba0710aa55a6cfdf72'],
		['destination fill (USDC in from solver, cbDOGE out)', '0x0dfd9a647c9d4d9a3dec8631d3faa4cbb02c8a7a5be462fe5e8bb475145f66bd'],
		['destination fill (USDC in from solver, cbDOGE out to an EOA)', '0x251e123494e1f7a0dc303fdd0ae2ebbd577ad7551029fe654eb508641d30f6dc'],
		['origin leg with no swap (USDC in, same USDC deposited)', '0x86992cdb478e7373e52657c8f5241431365c4d74dbe19ca6fc99bfd1318a6e3f'],
	])('classifies a Relay %s as CROSS_CHAIN_LEG', async (_label, hash) => {
		const r = await classifyTransaction(hash, 8453, { rpcUrl: RPC! });
		expect(r.reason).toBe('CROSS_CHAIN_LEG');
	}, 60000);

	it('still reports an ordinary non-swap as NOT_DECODABLE, not CROSS_CHAIN_LEG', async () => {
		// A real approval-only transaction (one Approval log, no bridge markers):
		// the cross-chain branch must not swallow the ordinary "not a swap" answer.
		const r = await classifyTransaction(
			'0x573eb9886b53fd886c67feca795c708e49fdf2f7fb0bc3a85aab55ede2ffc673',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r.reason).toBe('NOT_DECODABLE');
	}, 60000);
});
