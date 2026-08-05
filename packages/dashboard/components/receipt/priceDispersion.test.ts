import { describe, it, expect } from 'vitest';
import { dispersionBps, dispersionClause } from './priceDispersion';

describe('dispersionBps', () => {
  it('is population sigma relative to the At Block mid', () => {
    // mean 35.022467, population sigma 0.0039534 => 1.1288 bps of 35.0232
    expect(dispersionBps(35.0269, 35.0232, 35.0173)).toBeCloseTo(1.13, 2);
  });

  it('is exactly zero when the pool never moved', () => {
    // The COMMON case: the reference pool is usually not one the trade touched,
    // so all three blocks agree. This must render 0.00, not be suppressed.
    expect(dispersionBps(35.0232, 35.0232, 35.0232)).toBe(0);
  });

  it('returns null when any block is missing, rather than narrowing the sample', () => {
    // A sigma over 2 points renders identically to one over 3. The reader could
    // not tell them apart, so an incomplete triple yields nothing at all.
    expect(dispersionBps(null, 35.0232, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, null, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, 35.0232, null)).toBeNull();
  });

  it('returns null for non-finite or non-positive input', () => {
    expect(dispersionBps(35.0269, 0, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, Number.NaN, 35.0173)).toBeNull();
    expect(dispersionBps('abc', 35.0232, 35.0173)).toBeNull();
  });

  it('accepts numeric strings, since the DB returns numerics as strings', () => {
    expect(dispersionBps('35.0269', '35.0232', '35.0173')).toBeCloseTo(1.13, 2);
  });
});

describe('dispersionClause', () => {
  it('renders two decimals and a trailing period', () => {
    expect(dispersionClause(35.0269, 35.0232, 35.0173)).toBe(
      'Price deviates 1.13bps between blocks.',
    );
  });

  it('renders the zero case rather than omitting it', () => {
    expect(dispersionClause(35.0232, 35.0232, 35.0232)).toBe(
      'Price deviates 0.00bps between blocks.',
    );
  });

  it('is empty when the triple is incomplete', () => {
    expect(dispersionClause(null, 35.0232, 35.0173)).toBe('');
  });
});
