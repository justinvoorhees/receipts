/**
 * sql.ts — SQL string helpers, with no dependency on anything else.
 *
 * `sqlLiteral` began life inside writeParquet.ts, but a config loader
 * (routerRegistry.ts) and two SQL builders import it, none of which has any
 * business reaching into the Parquet writer for string escaping. It lives here
 * so those callers depend on a leaf instead.
 */

/** SQL string literal escaping — inputs are ours, but a stray quote must not build broken SQL. */
export function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
