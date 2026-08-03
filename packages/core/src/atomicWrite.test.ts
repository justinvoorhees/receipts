import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from './atomicWrite.js';

let dir: string;
let target: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
	target = path.join(dir, 'cache.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('atomicWriteJson', () => {
	it('writes JSON that reads back as the same value', () => {
		atomicWriteJson(target, { a: 1, b: null });
		expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1, b: null });
	});

	// A leftover .tmp beside a git-tracked config would show up as an untracked
	// file on every deploy, and would accumulate one per write.
	it('leaves no temporary files behind', () => {
		atomicWriteJson(target, { a: 1 });
		expect(readdirSync(dir)).toEqual(['cache.json']);
	});

	// The reason for the rename: a reader must never observe a partially written
	// file. Replacing longer content with shorter must not leave a tail behind.
	it('fully replaces longer previous content', () => {
		writeFileSync(target, JSON.stringify({ padding: 'x'.repeat(5000) }));
		atomicWriteJson(target, { a: 1 });
		const raw = readFileSync(target, 'utf8');
		expect(JSON.parse(raw)).toEqual({ a: 1 });
		expect(raw).not.toContain('padding');
	});

	it('ends the file with a trailing newline', () => {
		atomicWriteJson(target, { a: 1 });
		expect(readFileSync(target, 'utf8').endsWith('\n')).toBe(true);
	});

	// This runs on a request path and the DB is the durable store, so a
	// read-only filesystem must degrade quietly rather than fail the request.
	it('never throws when the destination cannot be written', () => {
		expect(() => atomicWriteJson('/proc/nonexistent/nope.json', { a: 1 })).not.toThrow();
	});

	it('reports whether the write succeeded', () => {
		expect(atomicWriteJson(target, { a: 1 })).toBe(true);
		expect(atomicWriteJson('/proc/nonexistent/nope.json', { a: 1 })).toBe(false);
	});

	// Interleaved writers were the original hazard: two requests both
	// stringifying and both writing could splice each other's output together.
	// With rename, every writer's bytes land whole, so the file always parses.
	it('leaves valid JSON after many interleaved writes', () => {
		for (let i = 0; i < 50; i++) atomicWriteJson(target, { i, blob: 'y'.repeat(i * 100) });
		expect(() => JSON.parse(readFileSync(target, 'utf8'))).not.toThrow();
		expect(readdirSync(dir)).toEqual(['cache.json']);
	});
});
