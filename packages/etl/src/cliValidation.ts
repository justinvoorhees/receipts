/**
 * cliValidation.ts — flag parsing/validation split out of cli.ts.
 *
 * cli.ts calls `program.parseAsync(process.argv)` at module load, so
 * importing it directly from a test would run the program against the test
 * process's own argv. These checks are pure functions instead, so they can be
 * unit tested without executing the CLI.
 *
 * Every check here exists to fail BEFORE any RPC call: a typo in a numeric
 * flag should name itself immediately rather than burn a run's worth of
 * eth_getBlockByNumber / debug_traceBlockByNumber calls, or worse, fall
 * through into an unrelated but validly-shaped block range.
 */

export function parsePositiveInt(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return n;
}

export function parseNonNegativeInt(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
	}
	return n;
}

/**
 * `--from` and `--to` describe one range and must be given together.
 * Commander leaves an un-passed option `undefined`, so supplying only one
 * used to fall through silently to the `--span` window — the operator's typed
 * block number was discarded and an unrelated `[head-span+1, head]` range was
 * ingested instead, with a success message and no indication anything was
 * wrong.
 */
export function assertFromToPaired(from: string | undefined, to: string | undefined): void {
	const hasFrom = from !== undefined;
	const hasTo = to !== undefined;
	if (hasFrom !== hasTo) {
		throw new Error(
			'--from and --to must be given together (both or neither), got ' +
				`${hasFrom ? `--from ${from}` : 'no --from'} and ${hasTo ? `--to ${to}` : 'no --to'}.`,
		);
	}
}
