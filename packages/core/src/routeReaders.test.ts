import { describe, expect, it, vi } from 'vitest';
import { makeV4PoolKeyReader, createDefaultV4PoolKeyReader } from './routeReaders.js';

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
