import { describe, expect, it } from 'vitest';
import { assertFromToPaired, parseNonNegativeInt, parsePositiveInt } from './cliValidation.js';

describe('parsePositiveInt', () => {
	it('accepts a positive integer string', () => {
		expect(parsePositiveInt('8', '--concurrency')).toBe(8);
	});

	it('rejects zero, naming the flag and the received value', () => {
		expect(() => parsePositiveInt('0', '--concurrency')).toThrow(
			'--concurrency must be a positive integer, got "0"',
		);
	});

	it('rejects a negative number', () => {
		expect(() => parsePositiveInt('-3', '--span')).toThrow(
			'--span must be a positive integer, got "-3"',
		);
	});

	it('rejects a non-numeric string', () => {
		expect(() => parsePositiveInt('abc', '--span')).toThrow(
			'--span must be a positive integer, got "abc"',
		);
	});

	it('rejects a non-integer (fractional) number', () => {
		expect(() => parsePositiveInt('2.5', '--concurrency')).toThrow(
			'--concurrency must be a positive integer, got "2.5"',
		);
	});

	// `Number()` accepts all of these. Each one silently became a plausible
	// integer, which for a flag that decides how much of a chain gets read is
	// the difference between a 300-block run and a 50-million-block one.
	it.each([
		['', 'the empty string'],
		[' ', 'whitespace only'],
		['\n5', 'a leading newline'],
		['0x10', 'hex notation'],
		['1e3', 'exponential notation'],
		['5 ', 'a trailing space'],
		['+5', 'an explicit plus sign'],
		['Infinity', 'Infinity'],
	])('rejects %j (%s), which Number() would have accepted', (raw) => {
		expect(() => parsePositiveInt(raw, '--concurrency')).toThrow(
			'--concurrency must be a positive integer',
		);
	});

	it('rejects a digit string too large to be an exact integer', () => {
		expect(() => parsePositiveInt('99999999999999999999', '--span')).toThrow(
			'--span must be a positive integer',
		);
	});
});

describe('parseNonNegativeInt', () => {
	it('accepts zero — genesis is a legitimate block number', () => {
		expect(parseNonNegativeInt('0', '--from')).toBe(0);
	});

	it('accepts a large positive integer', () => {
		expect(parseNonNegativeInt('50830910', '--from')).toBe(50830910);
	});

	it('rejects a negative number, naming the flag and the received value', () => {
		expect(() => parseNonNegativeInt('-1', '--to')).toThrow(
			'--to must be a non-negative integer, got "-1"',
		);
	});

	it('rejects a non-numeric string', () => {
		expect(() => parseNonNegativeInt('abc', '--from')).toThrow(
			'--from must be a non-negative integer, got "abc"',
		);
	});

	// `--from ""` used to parse as block 0. Paired with a real `--to` that is
	// a fifty-million-block range: ~150M RPC calls, then an OOM, because
	// ingest is all-or-nothing and holds the whole range in memory.
	it.each([
		['', 'the empty string'],
		[' ', 'whitespace only'],
		['\n5', 'a leading newline'],
		['0x10', 'hex notation'],
		['1e3', 'exponential notation'],
		['5 ', 'a trailing space'],
		['+5', 'an explicit plus sign'],
	])('rejects %j (%s), which Number() would have accepted', (raw) => {
		expect(() => parseNonNegativeInt(raw, '--from')).toThrow(
			'--from must be a non-negative integer',
		);
	});

	it('rejects a digit string too large to be an exact integer', () => {
		expect(() => parseNonNegativeInt('99999999999999999999', '--to')).toThrow(
			'--to must be a non-negative integer',
		);
	});
});

describe('assertFromToPaired', () => {
	it('allows both --from and --to given together', () => {
		expect(() => assertFromToPaired('100', '200')).not.toThrow();
	});

	it('allows neither given (the --span path)', () => {
		expect(() => assertFromToPaired(undefined, undefined)).not.toThrow();
	});

	it('rejects --from given without --to', () => {
		expect(() => assertFromToPaired('100', undefined)).toThrow(
			'--from and --to must be given together',
		);
	});

	it('rejects --to given without --from', () => {
		expect(() => assertFromToPaired(undefined, '200')).toThrow(
			'--from and --to must be given together',
		);
	});
});
