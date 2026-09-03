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
