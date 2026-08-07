/**
 * Levelled structured logging.
 *
 * With no database, log lines are the only record this service produces — so
 * they are a deliberate artifact rather than leftover debugging.
 *
 * One JSON object per line to stdout (stderr for warn/error), which is what
 * Railway ingests and what its field filters query. Nothing is written to disk,
 * nothing is rotated, nothing is retained by us. Durable logs, if ever wanted,
 * are a Railway log drain — not code here.
 *
 * The single implementation, exported via the `@fabric-tca/core/log`
 * subpath (see package.json `exports`). packages/dashboard/lib/log.ts
 * re-exports from here rather than duplicating it — dashboard can import
 * from core (and already does elsewhere), so there is no direction this
 * needs to be forked in. One LOG_LEVEL controls both, since core is
 * consumed as TypeScript source via transpilePackages and shares the
 * dashboard's runtime and env.
 */
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/**
 * Resolved once at module load. Unset defers to the NODE_ENV default; an
 * unrecognised (but set) value falls back to `info` outright rather than
 * throwing or silencing everything — a typo'd LOG_LEVEL must not be the
 * reason an incident has no logs.
 */
function configuredLevel(): Level {
	const raw = process.env.LOG_LEVEL?.toLowerCase();
	if (!raw) return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
	if ((LEVELS as readonly string[]).includes(raw)) return raw as Level;
	return 'info';
}

const threshold = RANK[configuredLevel()];

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
	if (RANK[level] > threshold) return;
	const line = `${JSON.stringify({ level, msg, ...fields })}\n`;
	// warn/error to stderr so a drain can split severity without parsing.
	if (level === 'error' || level === 'warn') process.stderr.write(line);
	else process.stdout.write(line);
}

export const log = {
	error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
	debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
	trace: (msg: string, fields?: Record<string, unknown>) => emit('trace', msg, fields),
};
