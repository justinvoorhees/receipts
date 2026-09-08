import { describe, expect, it } from 'vitest';

/**
 * The runtime bridge from compiled ETL code to core.
 *
 * `packages/core`'s default export is `./src/index.ts`, so a value import from
 * ETL compiles and passes vitest (which transpiles) then dies under `dist/`
 * with ERR_UNKNOWN_FILE_EXTENSION. `@fabric-tca/core/runtime` is the one path
 * that resolves to real JavaScript, and Task 7's runner depends on it.
 */
describe('@fabric-tca/core/runtime', () => {
	it('resolves to compiled JavaScript and exports analyzeTransaction', async () => {
		const mod = await import('@fabric-tca/core/runtime');
		expect(typeof mod.analyzeTransaction).toBe('function');
		expect(typeof mod.createMemoryFactCache).toBe('function');
		expect(typeof mod.fromSeedJson).toBe('function');
	});

	it('resolves to a .js file, not TypeScript source', async () => {
		const { createRequire } = await import('node:module');
		const require = createRequire(import.meta.url);
		const resolved = require.resolve('@fabric-tca/core/runtime');
		expect(resolved.endsWith('.js')).toBe(true);
		expect(resolved).toContain('dist');
	});
});
