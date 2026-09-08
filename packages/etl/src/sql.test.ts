import { describe, expect, it } from 'vitest';
import { sqlLiteral } from './sql.js';

describe('sqlLiteral', () => {
	it('wraps a plain value in single quotes', () => {
		expect(sqlLiteral('base')).toBe("'base'");
	});

	it('doubles an embedded single quote rather than emitting broken SQL', () => {
		expect(sqlLiteral("O'Router")).toBe("'O''Router'");
	});

	it('doubles every occurrence, not just the first', () => {
		expect(sqlLiteral("a'b'c")).toBe("'a''b''c'");
	});

	it('handles an empty string', () => {
		expect(sqlLiteral('')).toBe("''");
	});
});
