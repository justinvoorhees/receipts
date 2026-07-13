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
	it('classifies the Relay relayer trade with its EOA beneficiary', async () => {
		const r = await classifyTransaction(
			'0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r.reason).toBe('RELAYER_THIRD_PARTY');
		expect(r.detail?.beneficiary.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		// USDC in, native ETH out.
		expect(r.detail?.inputToken.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
		expect(r.detail?.outputToken).toBe('native');
	}, 60000);

	it('returns NOT_FOUND_ONCHAIN for a well-formed but absent hash', async () => {
		const r = await classifyTransaction('0x' + '0'.repeat(64), 8453, { rpcUrl: RPC! });
		expect(r.reason).toBe('NOT_FOUND_ONCHAIN');
	}, 60000);
});
