/**
 * Shared env + connection helpers for the analysis scripts in this directory.
 *
 * These read the repo-root .env directly rather than relying on the shell,
 * because `source .env` does not export by itself — a script that depends on
 * process.env alone silently sees nothing.
 */
import { readFileSync } from 'node:fs';

export const env = Object.fromEntries(
	readFileSync(new URL('../../.env', import.meta.url), 'utf8')
		.split('\n').filter((l) => l.includes('='))
		.map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

export async function connect() {
	const { default: postgres } = await import('postgres');
	return postgres(env.TCA_DATABASE_URL, { ssl: 'require', max: 1 });
}

export const core = (file) =>
	import(new URL(`../../packages/core/dist/${file}`, import.meta.url));

/** Median of an array of numbers. NaN on empty. */
export const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Quantile helper over an already-sorted array. */
export const quantile = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];

/** Cost-bearing legs only — wrap/unwrap are informational and carry no notional. */
export const costedLegs = (row) =>
	(row.route_legs ?? []).filter((l) => l.type !== 'wrap' && l.type !== 'unwrap');

export const num = (v) => (v == null ? null : Number(v));
