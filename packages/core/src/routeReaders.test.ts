import { describe, expect, it, vi } from 'vitest';

// log.ts resolves its threshold ONCE at module load from the ambient
// LOG_LEVEL env var. The 'warns, naming the consequence' tests below spy on
// process.stderr.write and assert on warn-level output — a developer with
// LOG_LEVEL=error exported (a legitimate local setting) would silently
// suppress those warn() calls and see unrelated, confusing failures. This has
// to be set BEFORE routeReaders.js (which imports log.js) is loaded — a
// static import at the top of this file would hoist above any assignment
// below it, so the module under test is loaded dynamically instead.
process.env.LOG_LEVEL = 'warn';

const {
  makeV4PoolKeyReader,
  createDefaultV4PoolKeyReader,
  createDefaultFeeReader,
  findInitializeLogByBisect,
} = await import('./routeReaders.js');

describe('makeV4PoolKeyReader', () => {
  const POOL = '0xAbC123';
  const initLog = { args: { currency0: '0xAAAA1111', currency1: '0xBBBB2222' } };

  it('resolves and lowercases currencies from the first Initialize log', async () => {
    const reader = makeV4PoolKeyReader(async () => [initLog]);
    expect(await reader(POOL)).toEqual({ currency0: '0xaaaa1111', currency1: '0xbbbb2222' });
  });

  it('caches per poolId: the underlying fetch runs once across repeated (case-insensitive) ids', async () => {
    const fetch = vi.fn(async () => [initLog]);
    const reader = makeV4PoolKeyReader(fetch);
    await reader(POOL);
    await reader(POOL.toLowerCase());
    await reader(POOL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when no Initialize log is found', async () => {
    const reader = makeV4PoolKeyReader(async () => []);
    expect(await reader(POOL)).toBeNull();
  });

  it('returns null (never throws) when the fetch errors, and caches the null', async () => {
    const fetch = vi.fn(async () => { throw new Error('rpc down'); });
    const reader = makeV4PoolKeyReader(fetch);
    expect(await reader(POOL)).toBeNull();
    await reader(POOL);
    expect(fetch).toHaveBeenCalledTimes(1); // null was cached, not re-fetched
  });
});

describe('createDefaultV4PoolKeyReader', () => {
  it('returns a no-op reader (always null) when rpcUrl is empty', async () => {
    const reader = createDefaultV4PoolKeyReader('', 1000n);
    expect(await reader('0xabc')).toBeNull();
  });

  // Guards the provider-portability bug that shipped with the QuickNode
  // migration: the old implementation asked for a ~24M-block eth_getLogs, which
  // Alchemy served and QuickNode rejected. The reader swallows throws, so the
  // rejection surfaced only as null currencies — V4 legs collapsed and lpFeeBps
  // went null. This resolves a REAL pool against whatever RPC is configured, so
  // it fails on any provider that cannot answer the wide query.
  it.skipIf(!process.env.TCA_RPC_URL)(
    'resolves a real V4 pool key against the configured RPC',
    async () => {
      // id 207's V4 pool; Initialize emitted at block 35,830,683.
      const poolId = '0xa45b43f690974df2ff5d1f9807786fab3adec320d26c76570ea2e483c80d08e1';
      const reader = createDefaultV4PoolKeyReader(process.env.TCA_RPC_URL!, 49_000_000n);
      expect(await reader(poolId)).toEqual({
        currency0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        currency1: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
      });
    },
    60_000,
  );
});

// Uniswap's PoolManager exposes no poolIdToPoolKey, so the currencies can only
// come from the historical Initialize log. Scanning for it from the deploy block
// is a ~24M-block eth_getLogs, which QuickNode rejects outright (10,000-block
// range cap) — and because makeV4PoolKeyReader swallows the throw, the failure
// was indistinguishable from "this pool does not exist": V4 legs silently
// collapsed and lpFeeBps went null. Bisect on initialized-ness instead, using
// state reads, then fetch logs for the ONE block the search lands on.
describe('findInitializeLogByBisect', () => {
  const DEPLOY = 25_350_988n;
  const HEAD = 49_493_825n;
  const INIT = 35_830_683n; // real Initialize block for id 207's pool
  const LOG = { args: { currency0: '0xAAAA1111', currency1: '0xBBBB2222' } };

  /** A chain where the pool becomes initialized at INIT and stays so. */
  const chainWithInit = (initBlock: bigint | null) => {
    const probed: bigint[] = [];
    const ranges: { from: bigint; to: bigint }[] = [];
    return {
      probed,
      ranges,
      isInitializedAt: async (b: bigint) => {
        probed.push(b);
        return initBlock !== null && b >= initBlock;
      },
      getLogsInRange: async (from: bigint, to: bigint) => {
        ranges.push({ from, to });
        return initBlock !== null && from <= initBlock && initBlock <= to ? [LOG] : [];
      },
    };
  };

  it('finds the Initialize log by bisecting on initialized-ness', async () => {
    const chain = chainWithInit(INIT);
    const logs = await findInitializeLogByBisect(chain, DEPLOY, HEAD);
    expect(logs).toEqual([LOG]);
  });

  it('lands on the exact initialization block, so the log query spans a single block', async () => {
    const chain = chainWithInit(INIT);
    await findInitializeLogByBisect(chain, DEPLOY, HEAD);
    expect(chain.ranges).toEqual([{ from: INIT, to: INIT }]);
  });

  // The whole point: a range cap can never be hit if we never ask for a range.
  it('never requests a block range wide enough to trip a provider cap', async () => {
    const chain = chainWithInit(INIT);
    await findInitializeLogByBisect(chain, DEPLOY, HEAD);
    for (const r of chain.ranges) expect(r.to - r.from).toBeLessThan(10_000n);
  });

  it('probes logarithmically, not linearly, across a 24M-block span', async () => {
    const chain = chainWithInit(INIT);
    await findInitializeLogByBisect(chain, DEPLOY, HEAD);
    // log2(24.1M) ≈ 24.5; allow headroom but stay far below a chunked scan's ~2400
    expect(chain.probed.length).toBeLessThanOrEqual(30);
  });

  it('returns [] without fetching any logs when the pool is not initialized at toBlock', async () => {
    const chain = chainWithInit(null);
    expect(await findInitializeLogByBisect(chain, DEPLOY, HEAD)).toEqual([]);
    expect(chain.ranges).toEqual([]);
  });

  it('handles a pool initialized in the deploy block itself', async () => {
    const chain = chainWithInit(DEPLOY);
    expect(await findInitializeLogByBisect(chain, DEPLOY, HEAD)).toEqual([LOG]);
    expect(chain.ranges).toEqual([{ from: DEPLOY, to: DEPLOY }]);
  });

  it('handles a pool initialized in the toBlock itself', async () => {
    const chain = chainWithInit(HEAD);
    expect(await findInitializeLogByBisect(chain, DEPLOY, HEAD)).toEqual([LOG]);
    expect(chain.ranges).toEqual([{ from: HEAD, to: HEAD }]);
  });
});

// An UNRESOLVED fee must never be indistinguishable from a pool that is
// genuinely free: a 0 bps result reported as `defaulted: false` renders on the
// receipt as a confident "0.00bps", i.e. a false claim rather than a missing
// one. Both silent paths below returned exactly that.
describe('createDefaultFeeReader — unresolved fees are reported, not disguised', () => {
  // A syntactically valid but dead endpoint: readContract rejects (ECONNREFUSED)
  // so we exercise the real catch path rather than mocking the client.
  const DEAD_RPC = 'http://127.0.0.1:1';
  const POOL = '0x1111111111111111111111111111111111111111';

  it('flags a univ4 leg whose Swap event carried no fee (v4FeeRaw undefined) as defaulted', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'univ4', undefined);
      expect(result).toEqual({ bps: 0, defaulted: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('warns, naming the consequence, when a univ4 fee is unresolved', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'univ4', undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      const written = JSON.parse(warn.mock.calls[0]![0] as string);
      expect(written.module).toBe('createDefaultFeeReader');
      expect(written.msg).toMatch(/LP fee will read 0 bps/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT flag or warn for a univ4 leg whose fee came through on the event', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'univ4', 500);
      expect(result).toEqual({ bps: 5, defaulted: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['univ3', 'sushiv3', 'baseswapv3', 'pancakev3', 'hydrex', 'quickswapv4'] as const)(
    'flags a %s leg as defaulted when the fee() read fails',
    async (type) => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, type);
        expect(result).toEqual({ bps: 0, defaulted: true });
        expect(warn).toHaveBeenCalledTimes(1);
        const written = JSON.parse(warn.mock.calls[0]![0] as string);
        expect(written.msg).toMatch(/LP fee will read 0 bps/);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('leaves aerodrome_cl alone — it already reported unresolved fees correctly', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'aerodrome_cl');
      expect(result).toEqual({ bps: 0, defaulted: true });
    } finally {
      warn.mockRestore();
    }
  });

  // Aerodrome's fee lives on the FACTORY (getFee(pool, stable)) and is per-pool.
  // It used to return a hardcoded 30bps with no RPC call at all, which understated
  // receipt 173's pool by 50bps (its real fee is 80) while the pool's PoolFees
  // accumulator leaked the true amount into the third-party fee row.
  it('marks an aerodrome leg defaulted only when the factory read FAILS', async () => {
    const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'aerodrome');
    expect(result).toEqual({ bps: 30, defaulted: true });
  });

  it('reports a successful aerodrome read as a measurement, at the factory rate', async () => {
    const rpc = 'http://aerodrome-stub.invalid';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      type RpcCall = { id: number; params?: [{ data?: string }] };
      const body: RpcCall | RpcCall[] = JSON.parse(String((init as RequestInit).body));
      const calls: RpcCall[] = Array.isArray(body) ? body : [body];
      const answer = (c: RpcCall) => {
        const data = String(c.params?.[0]?.data ?? '');
        if (data.startsWith('0xc45a0155')) return `0x${'00'.repeat(12)}${'fa'.repeat(20)}`; // factory()
        if (data.startsWith('0x22be3de1')) return `0x${'00'.repeat(32)}`;                    // stable() -> false
        return `0x${(80).toString(16).padStart(64, '0')}`;                                   // getFee() -> 80
      };
      const res = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: answer(c) }));
      return new Response(JSON.stringify(Array.isArray(body) ? res : res[0]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const result = await createDefaultFeeReader(rpc, 1000n)(POOL, 'aerodrome');
      expect(result).toEqual({ bps: 80, defaulted: false });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('keeps rfq at a genuine zero — a maker fill has no LP fee to resolve', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'rfq');
      expect(result).toEqual({ bps: 0, defaulted: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('makeInfinityPoolKeyReader', () => {
  it('lowercases currencies and caches per poolId, including a miss', async () => {
    let calls = 0;
    const { makeInfinityPoolKeyReader } = await import('./routeReaders.js');
    const reader = makeInfinityPoolKeyReader(async (poolId) => {
      calls++;
      return poolId === '0xaa'
        ? { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' }
        : null;
    });
    expect(await reader('0xAA')).toEqual({
      currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
    await reader('0xaa');
    expect(calls).toBe(1); // cached

    expect(await reader('0xbb')).toBeNull();
    await reader('0xbb');
    expect(calls).toBe(2); // a null miss is cached too, not retried
  });

  it('never throws — a failing fetch degrades to null', async () => {
    const { makeInfinityPoolKeyReader } = await import('./routeReaders.js');
    const reader = makeInfinityPoolKeyReader(async () => { throw new Error('rpc down'); });
    await expect(reader('0xaa')).resolves.toBeNull();
  });
});

describe('pancake_infinity fee reader', () => {
  it('converts LP pips to bps and reports the fee as resolved', async () => {
    const { createDefaultFeeReader } = await import('./routeReaders.js');
    // 'unused' short-circuits the RPC client; the univ4/infinity cases read
    // their fee off the leg, so they still answer.
    const read = createDefaultFeeReader('unused', 1n);
    const out = await read('inf:0xf6', 'pancake_infinity', 47);
    expect(out.bps).toBeCloseTo(0.47, 6);
    expect(out.defaulted).toBe(false);
  });

  it('reports unresolved when the leg carries no fee', async () => {
    const { createDefaultFeeReader } = await import('./routeReaders.js');
    const read = createDefaultFeeReader('unused', 1n);
    const out = await read('inf:0xf6', 'pancake_infinity', undefined);
    expect(out.defaulted).toBe(true);
  });
});
