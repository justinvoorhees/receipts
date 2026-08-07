import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Write JSON so a reader never sees a half-written file.
 *
 * The naive `writeFileSync(path, json)` is not atomic: two requests resolving
 * contract names concurrently can interleave and splice each other's output
 * into one unparseable file. Writing to a sibling temp file and renaming makes
 * the swap atomic on POSIX — every reader sees either the old file or the new
 * one, never a mixture.
 *
 * Returns whether the write landed. Never throws: this runs on a request path
 * and its only caller (contractNames.ts's persistCache) treats the write as a
 * best-effort, per-instance cache with no durable store behind it — a
 * read-only filesystem (serverless, a locked-down container) must degrade
 * quietly, not fail the request.
 */
export function atomicWriteJson(filePath: string, data: unknown): boolean {
	// Same directory as the target: rename is only atomic within a filesystem,
	// and /tmp is frequently a different mount.
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
		renameSync(tmpPath, filePath);
		return true;
	} catch {
		// Clean up a temp file that was created before the failure, so a failing
		// write cannot litter one .tmp per attempt beside a tracked config.
		try {
			unlinkSync(tmpPath);
		} catch {
			// Nothing to remove, or the directory itself is unwritable.
		}
		return false;
	}
}
