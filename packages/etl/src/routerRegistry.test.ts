import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRouterRegistry, routerValuesSql } from './routerRegistry.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'routerRegistry-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(routers: unknown[]): string {
	const path = join(dir, 'routers.json');
	writeFileSync(path, JSON.stringify({ _comment: 'x', routers }));
	return path;
}

describe('loadRouterRegistry', () => {
	it('lowercases addresses so the join against tx_to works', async () => {
		const path = writeConfig([
			{ name: 'Odos', address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1', version: 'V2', active: true },
		]);
		expect(await loadRouterRegistry(path)).toEqual([
			{ address: '0x19ceead7105607cd444f5ad10dd51356436095a1', name: 'Odos', version: 'V2' },
		]);
	});

	it('skips inactive routers', async () => {
		const path = writeConfig([
			{ name: 'A', address: '0xaa', version: '1', active: true },
			{ name: 'B', address: '0xbb', version: '1', active: false },
		]);
		const entries = await loadRouterRegistry(path);
		expect(entries.map((e) => e.name)).toEqual(['A']);
	});

	it('throws when the file has no active routers, rather than building an empty filter', async () => {
		const path = writeConfig([{ name: 'B', address: '0xbb', version: '1', active: false }]);
		await expect(loadRouterRegistry(path)).rejects.toThrow(/no active routers/);
	});

	it('names the path it could not read', async () => {
		await expect(loadRouterRegistry(join(dir, 'missing.json'))).rejects.toThrow(/missing\.json/);
	});

	it('loads the real repo registry', async () => {
		const entries = await loadRouterRegistry('configs/routers.json');
		expect(entries.length).toBeGreaterThanOrEqual(20);
		expect(entries.every((e) => e.address === e.address.toLowerCase())).toBe(true);
		expect(entries.map((e) => e.name)).toContain('Odos');
	});
});

describe('routerValuesSql', () => {
	it('renders a VALUES list', () => {
		expect(
			routerValuesSql([
				{ address: '0xaa', name: 'A', version: 'V1' },
				{ address: '0xbb', name: 'B', version: 'V2' },
			]),
		).toBe("('0xaa','A','V1'),('0xbb','B','V2')");
	});

	it('escapes a single quote in a name rather than emitting broken SQL', () => {
		expect(routerValuesSql([{ address: '0xaa', name: "O'Router", version: 'V1' }])).toBe(
			"('0xaa','O''Router','V1')",
		);
	});

	it('refuses an empty list', () => {
		expect(() => routerValuesSql([])).toThrow(/at least one router/);
	});
});
