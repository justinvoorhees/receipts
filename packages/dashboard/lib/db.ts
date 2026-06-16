import { createDb } from '@fabric-tca/db';

declare global {
	// eslint-disable-next-line no-var
	var __tcaDb: ReturnType<typeof createDb> | undefined;
}

export function getDb() {
	if (!process.env.TCA_DATABASE_URL) {
		throw new Error('TCA_DATABASE_URL is not set');
	}
	if (!globalThis.__tcaDb) {
		globalThis.__tcaDb = createDb(process.env.TCA_DATABASE_URL);
	}
	return globalThis.__tcaDb;
}
