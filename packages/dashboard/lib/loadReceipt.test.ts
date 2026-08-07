import { describe, expect, it, vi, beforeEach } from 'vitest';

const analyzeTransaction = vi.fn();
const enrichFeeSinkNames = vi.fn();
const resolveLegRouter = vi.fn();

vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: (...a: unknown[]) => analyzeTransaction(...a),
	enrichFeeSinkNames: (...a: unknown[]) => enrichFeeSinkNames(...a),
	resolveAggregator: () => ({ slug: 'odos' }),
	resolveLegRouter: (...a: unknown[]) => resolveLegRouter(...a),
}));

const { loadReceipt } = await import('./loadReceipt');
const { DEFAULT_CHAIN } = await import('./chains');

const RECEIPT = {
	txHash: '0x' + 'a'.repeat(64),
	chainId: 8453,
	aggregator: 'odos',
	routerAddress: '0xrouter',
	feeSinks: [{ address: '0xsink', feeBps: 5, source: 'vault_map' }],
	routeLegs: [{ venue: '0xpool', type: 'v3' }],
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.TCA_RPC_URL = 'https://rpc.example';
	enrichFeeSinkNames.mockImplementation(async (sinks) =>
		sinks.map((s: { address: string }) => ({ ...s, name: 'Named Sink' })),
	);
	resolveLegRouter.mockReturnValue(null);
});

describe('loadReceipt', () => {
	it('analyzes the transaction on the chain it was given', async () => {
		analyzeTransaction.mockResolvedValue(RECEIPT);
		await loadReceipt(DEFAULT_CHAIN, RECEIPT.txHash);
		expect(analyzeTransaction).toHaveBeenCalledWith(RECEIPT.txHash, DEFAULT_CHAIN.id, {
			rpcUrl: 'https://rpc.example',
		});
	});

	it('returns null when the transaction cannot be analyzed', async () => {
		analyzeTransaction.mockResolvedValue(null);
		expect(await loadReceipt(DEFAULT_CHAIN, RECEIPT.txHash)).toBeNull();
	});

	// Both enrichments used to happen elsewhere — fee-sink names at persist time,
	// leg routers at read time. If either is dropped in the move, the receipt
	// renders a bare address where a name belongs, which no type catches.
	it('resolves fee-sink names', async () => {
		analyzeTransaction.mockResolvedValue(RECEIPT);
		const out = await loadReceipt(DEFAULT_CHAIN, RECEIPT.txHash);
		expect(out!.feeSinks[0]!.name).toBe('Named Sink');
	});

	it('runs leg-router enrichment over the legs', async () => {
		// toHaveLength(1) alone would pass even if enrichment were skipped
		// entirely, since the raw leg array already has length 1 — assert on
		// the enrichment's actual effect (the resolved `router` field) instead.
		resolveLegRouter.mockReturnValue({ slug: 'fabric', name: 'Fabric' });
		analyzeTransaction.mockResolvedValue(RECEIPT);
		const out = await loadReceipt(DEFAULT_CHAIN, RECEIPT.txHash);
		expect(out!.routeLegs![0]!.router).toEqual({ slug: 'fabric', name: 'Fabric' });
	});

	// A missing RPC URL must not read as "this transaction does not exist".
	it('throws rather than returning null when TCA_RPC_URL is unset', async () => {
		delete process.env.TCA_RPC_URL;
		await expect(loadReceipt(DEFAULT_CHAIN, RECEIPT.txHash)).rejects.toThrow(/TCA_RPC_URL/);
	});
});
