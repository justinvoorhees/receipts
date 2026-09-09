import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * coreImportDiscipline.test.ts — one guard for the whole package, not three
 * near-duplicates.
 *
 * `packages/etl` may VALUE-import from `@fabric-tca/core` only via the
 * `./runtime` subpath (resolves to compiled `dist/index.js`). Every other
 * subpath is TypeScript SOURCE:
 *   '.'       (the bare specifier) -> ./src/index.ts
 *   './pure'                       -> ./src/receiptPure.ts
 *   './log'                        -> ./src/log.ts
 * A value import from any of those three compiles, typechecks and passes
 * vitest (which transpiles) — then dies at runtime under `dist/` with
 * ERR_UNKNOWN_FILE_EXTENSION, because node cannot load a .ts file. Types may
 * come from any subpath; only VALUE imports are restricted.
 *
 * factCacheStore.test.ts, receiptRows.test.ts and buildReceipts.test.ts each
 * used to hand-roll this same regex against the bare specifier only — opt-in
 * per file, and blind to './pure' and './log'. './pure' is exactly the
 * subpath the dashboard's client components are told to use, so it is the
 * likeliest one a future etl author reaches for out of habit. This test
 * covers every `.ts` file under packages/etl/src, present or future, with no
 * opt-in required.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/** One import statement whose specifier starts with the core package name,
 *  matched across however many lines a formatter wraps it onto — a
 *  line-based filter only ever sees the surviving `from '<specifier>'` line,
 *  which carries no `type` keyword to fail on, so a wrapped value import
 *  would escape a line-scoped check entirely. */
// The clause is [^;]*? (no semicolon), not [\s\S]*? — an import statement
// never contains a bare semicolon before its own `from`, so excluding one
// stops the non-greedy match from skipping over an EARLIER, unrelated
// import's `from '...'` and merging two separate statements into one clause.
const IMPORT_RE = /import\s+([^;]*?)\s+from\s*['"](@fabric-tca\/core[^'"]*)['"]/g;

/** True when the import clause (everything between `import` and `from`) is
 *  entirely type-only: either the whole clause starts with `type ` (`import
 *  type {...} from ...` / `import type Foo from ...`), or it is a `{ }` named
 *  block where every binding is individually prefixed `type `. A default or
 *  namespace import, or any bare (non-`type`) named binding, is a VALUE
 *  import and this returns false. */
function isTypeOnlyClause(clause: string): boolean {
	const trimmed = clause.trim();
	if (trimmed.startsWith('type ')) return true;
	const braceMatch = trimmed.match(/^\{([\s\S]*)\}$/);
	if (!braceMatch) return false; // default / namespace import — always a value import
	const names = braceMatch[1]!
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return names.length > 0 && names.every((n) => n.startsWith('type '));
}

interface Violation {
	file: string;
	specifier: string;
	clause: string;
}

/** Every non-type-only import from `@fabric-tca/core` (any subpath) whose
 *  specifier is not exactly `@fabric-tca/core/runtime`. */
function findViolations(files: readonly string[]): Violation[] {
	const violations: Violation[] = [];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		for (const match of src.matchAll(IMPORT_RE)) {
			const clause = match[1]!;
			const specifier = match[2]!;
			if (isTypeOnlyClause(clause)) continue;
			if (specifier === '@fabric-tca/core/runtime') continue;
			violations.push({ file, specifier, clause: clause.trim() });
		}
	}
	return violations;
}

describe('core import discipline', () => {
	it('never value-imports from @fabric-tca/core except the ./runtime subpath', () => {
		const files = listTsFiles(SRC_DIR);
		// A guard over zero files proves nothing — fail loudly if the scan
		// somehow came back empty (e.g. run from the wrong cwd).
		expect(files.length).toBeGreaterThan(0);

		const violations = findViolations(files);
		expect(violations).toEqual([]);
	});
});
