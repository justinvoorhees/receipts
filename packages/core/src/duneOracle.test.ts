import { describe, expect, it, vi } from 'vitest';
import { parseDuneEthUsd, makeDuneEthUsdOracle } from './duneOracle.js';

describe('parseDuneEthUsd', () => {
  it('extracts price + asOf from a result row', () => {
    const out = parseDuneEthUsd({ result: { rows: [{ price: 3001.5, minute: '2026-06-29T12:00:00Z' }] } });
    expect(out).toEqual({ price: 3001.5, asOfSecs: Math.floor(Date.parse('2026-06-29T12:00:00Z') / 1000) });
  });
  it('returns null on empty rows', () => {
    expect(parseDuneEthUsd({ result: { rows: [] } })).toBeNull();
  });
  it('returns null on malformed payload', () => {
    expect(parseDuneEthUsd({})).toBeNull();
  });
});

describe('makeDuneEthUsdOracle', () => {
  it('returns null (never throws) when fetch rejects', async () => {
    const oracle = makeDuneEthUsdOracle('key', vi.fn().mockRejectedValue(new Error('network')));
    expect(await oracle(1_700_000_000)).toBeNull();
  });
});
