import 'dotenv/config';
import type { Config } from 'drizzle-kit';

/**
 * Drizzle-kit config. Migrations live with the schema in `packages/db/drizzle`
 * so the package is self-contained.
 *
 * Generate after schema edits: `npm run db:generate`
 * Apply against the configured database: `npm run db:migrate`
 */
export default {
	schema: './packages/db/src/schema.ts',
	out: './packages/db/drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.TCA_DATABASE_URL ?? '',
	},
	strict: true,
	verbose: true,
} satisfies Config;
