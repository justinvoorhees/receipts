import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockPayloads } from './buildSeedRows.js';
import { ingestRange } from './ingest.js';

/**
 * ingest.wiring.test.ts — the SEAMS between ingest's modules, driven end to end
 * with a stubbed `fetch` and a real Parquet write.
 *
 * Every module here has good unit coverage; what had none was the wiring
 * between them. `seedPath.test.ts` pins `seedFilePath`'s routing and
 * `finality.test.ts` pins `classifyRange`'s return, but nothing pinned that
 * `ingestRange` carries the second into the first — a mutant hardcoding
 * `finalized: true` at the call site left the whole suite green while writing
 * unfinalized data into the canonical archive. Spec §9 test 5 asks for exactly
 * this ("*and* that the flag routes output to `provisional/`").
 *
 * No network: `fetch` is stubbed with fixture-derived payloads, so these are
 * fast and cost nothing. The live pipeline test is `ingest.e2e.test.ts`.
 */

// A source-adjacent fixture, never built or deployed — the one place
// `import.meta.url` is correct in this package. Runtime DATA paths still come
// from a CLI argument.
const RAW = readFileSync(
	fileURLToPath(new URL('./__fixtures__/block-50795977.json', import.meta.url)),
	'utf8',
);

const hex = (n: number): string => `0x${n.toString(16)}`;

/**
 * The fixture block, rewritten to claim it IS block `n`. The three payloads
 * each carry their own block identity and `buildSeedRows` cross-checks all of
 * them, so every copy has to be moved together.
 */
function payloadsForBlock(n: number): BlockPayloads {
	const p = JSON.parse(RAW) as BlockPayloads;
	const blockHash = `0x${n.toString(16).padStart(64, '0')}`;
	p.block.number = hex(n);
	p.block.hash = blockHash;
	for (const r of p.receipts) {
		r.blockNumber = hex(n);
		r.blockHash = blockHash;
	}
	for (const t of p.block.transactions) {
		t.blockNumber = hex(n);
		t.blockHash = blockHash;
	}
	return p;
}

interface StubOptions {
	/** The block number `eth_getBlockByNumber('finalized')` reports. */
	head: number;
	chainIdHex?: string;
	/** Which block the endpoint actually DELIVERS for a requested tag. */
	deliver?: (requested: number) => BlockPayloads;
}

/** Stub `fetch` at the global seam `rpcCall` uses by default, and record every method asked for. */
function stubRpc(options: StubOptions): { methods: string[] } {
	const methods: string[] = [];
	const deliver = options.deliver ?? payloadsForBlock;

	const fetchFn = async (_url: string, init: RequestInit) => {
		const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
		methods.push(request.method);
		const result = ((): unknown => {
			switch (request.method) {
				case 'eth_chainId':
					return options.chainIdHex ?? '0x2105';
				case 'eth_getBlockByNumber': {
					const tag = request.params[0] as string;
					if (tag === 'finalized') return { number: hex(options.head) };
					return deliver(Number.parseInt(tag, 16)).block;
				}
				case 'eth_getBlockReceipts':
					return deliver(Number.parseInt(request.params[0] as string, 16)).receipts;
				case 'debug_traceBlockByNumber':
					return deliver(Number.parseInt(request.params[0] as string, 16)).traceBlock;
				default:
					throw new Error(`Stub has no answer for ${request.method}`);
			}
		})();
		return {
			ok: true,
			status: 200,
			headers: { get: (): string | null => null },
			json: async () => ({ result }),
		};
	};

	vi.stubGlobal('fetch', fetchFn);
	return { methods };
}

describe('ingestRange wiring (stubbed fetch, real Parquet write)', () => {
	let dir: string;

	afterEach(() => {
		vi.unstubAllGlobals();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function baseOpts(overrides: Partial<Parameters<typeof ingestRange>[0]> = {}) {
		dir = mkdtempSync(join(tmpdir(), 'etl-wiring-'));
		return {
			rpcUrl: 'https://rpc.example.invalid/v2/sk_live_TESTSECRET',
			chain: 'base',
			chainId: 8453,
			fromBlock: 10,
			toBlock: 12,
			dataDir: dir,
			source: 'stub-endpoint',
			allowUnfinalized: false,
			concurrency: 2,
			...overrides,
		};
	}

	it('routes a finalized range into the canonical archive', async () => {
		stubRpc({ head: 1000 });
		const result = await ingestRange(baseOpts());

		expect(result.finality).toBe('finalized');
		expect(result.rowCount).toBe(9);
		expect(result.outPath).toBe(join(dir, 'seeds', 'traces.base.0000000010-0000000012.parquet'));
		expect(existsSync(result.outPath)).toBe(true);
	});

	/**
	 * Spec §9 test 5's second clause. The canonical archive is the NON-recursive
	 * glob `data/seeds/*.parquet`, so the whole guarantee rests on an
	 * unfinalized file landing one directory deeper — and on `ingestRange`
	 * actually passing `classifyRange`'s verdict through to `seedFilePath`.
	 */
	it('routes an unfinalized range into provisional/, out of the canonical glob', async () => {
		stubRpc({ head: 5 });
		const result = await ingestRange(baseOpts({ allowUnfinalized: true }));

		expect(result.finality).toBe('unsafe');
		expect(result.outPath).toBe(
			join(dir, 'seeds', 'provisional', 'traces.base.0000000010-0000000012.parquet'),
		);
		expect(existsSync(result.outPath)).toBe(true);
		// The canonical archive is `seeds/*.parquet`, non-recursive: it must see
		// nothing at all here, not merely a differently-named file.
		expect(readdirSync(join(dir, 'seeds')).filter((e) => e.endsWith('.parquet'))).toEqual([]);
	});

	it('still refuses an unfinalized range without the flag, before writing anything', async () => {
		stubRpc({ head: 5 });
		await expect(ingestRange(baseOpts())).rejects.toThrow(/--allow-unfinalized/);
		expect(existsSync(join(dir, 'seeds'))).toBe(false);
	});

	/**
	 * The admission rule is a property of the ROW. The range check runs against
	 * the REQUEST; `block_number` comes from the RESPONSE. An endpoint that
	 * answers every request with one block therefore used to produce a
	 * correctly-named, correctly-labelled `finalized` file whose rows had never
	 * been compared to the finalized head at all.
	 */
	it('aborts when the endpoint delivers a block other than the one requested', async () => {
		stubRpc({ head: 60_000_000, deliver: () => JSON.parse(RAW) as BlockPayloads });

		await expect(ingestRange(baseOpts())).rejects.toThrow(
			/Requested block 1[012] but the endpoint returned block 50795977/,
		);
		expect(existsSync(join(dir, 'seeds'))).toBe(false);
	});

	/**
	 * `chain_id` is otherwise an operator assertion and `chain` is an
	 * uncorrelated filename slug, so an endpoint pointed at the wrong chain
	 * produces a perfectly well-formed `traces.base.*` file full of another
	 * chain's blocks, permanently, with nothing downstream able to tell.
	 */
	it('aborts when the endpoint is a different chain than --chain-id claims', async () => {
		const { methods } = stubRpc({ head: 1000, chainIdHex: '0x1' });

		await expect(ingestRange(baseOpts())).rejects.toThrow(
			/Endpoint is chain 1, but --chain-id says 8453/,
		);
		// One call per RUN, and it must come first: nothing else may be spent
		// on an endpoint we have not identified.
		expect(methods).toEqual(['eth_chainId']);
		expect(existsSync(join(dir, 'seeds'))).toBe(false);
	});

	it('aborts when the endpoint returns an unparseable chain id', async () => {
		stubRpc({ head: 1000, chainIdHex: 'not-hex' });
		await expect(ingestRange(baseOpts())).rejects.toThrow(/unparseable eth_chainId/);
	});

	it('checks the chain exactly once for the whole run, not once per block', async () => {
		const { methods } = stubRpc({ head: 1000 });
		await ingestRange(baseOpts());
		expect(methods.filter((m) => m === 'eth_chainId')).toHaveLength(1);
	});
});
