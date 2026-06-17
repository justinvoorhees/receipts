import type { Db } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';

/**
 * Upsert a liveness row for an ingest service. The dashboard reads
 * `ingest_heartbeats` and renders staleness; if the row is older than a
 * few minutes the service is considered down regardless of OS process
 * state (it can be alive but RPC-blocked, etc.).
 */
export async function writeHeartbeat(
	db: Db,
	service: 'poller' | 'promoter',
	{
		lastBlock,
		status,
		error,
	}: { lastBlock?: number; status: 'ok' | 'error'; error?: string },
): Promise<void> {
	try {
		await db
			.insert(schema.ingestHeartbeats)
			.values({
				service,
				lastTickAt: new Date(),
				lastBlock: lastBlock ?? null,
				lastStatus: status,
				lastError: error ?? null,
			})
			.onConflictDoUpdate({
				target: schema.ingestHeartbeats.service,
				set: {
					lastTickAt: new Date(),
					lastBlock: lastBlock ?? null,
					lastStatus: status,
					lastError: error ?? null,
				},
			});
	} catch {
		// A failed heartbeat must never crash the caller. If the DB is down,
		// the caller already has bigger problems and the dashboard will show
		// staleness on its own.
	}
}
