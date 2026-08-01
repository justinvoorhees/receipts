import { describe, expect, it, vi } from 'vitest';
import { makeV4PoolKeyReader, createDefaultV4PoolKeyReader, createDefaultFeeReader } from './routeReaders.js';

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'univ4', undefined);
      expect(result).toEqual({ bps: 0, defaulted: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('warns, naming the consequence, when a univ4 fee is unresolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, 'univ4', undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/\[createDefaultFeeReader\]/);
      expect(warn.mock.calls[0]![0]).toMatch(/LP fee will read 0 bps/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT flag or warn for a univ4 leg whose fee came through on the event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await createDefaultFeeReader(DEAD_RPC, 1000n)(POOL, type);
        expect(result).toEqual({ bps: 0, defaulted: true });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toMatch(/LP fee will read 0 bps/);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('leaves aerodrome_cl alone — it already reported unresolved fees correctly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
