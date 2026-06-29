import { schema } from '@fabric-tca/db';

export type Dataset = 'funnel' | 'smoke' | 'smoke02' | 'smoke03' | 'smoke04' | 'smoke05';
// Funnel (v2.1 `router_trades_gated`) is ARCHIVED — its data is preserved and
// still reachable via an explicit `?ds=funnel` URL, but it is no longer surfaced
// in the UI. Smoke is the active dataset moving forward.
export const DEFAULT_DATASET: Dataset = 'smoke';

export function parseDataset(v: string | undefined): Dataset {
	if (v === 'smoke02') return 'smoke02';
	if (v === 'smoke03') return 'smoke03';
	if (v === 'smoke04') return 'smoke04';
	if (v === 'smoke05') return 'smoke05';
	if (v === 'funnel') return 'funnel'; // archived — only via explicit ?ds=funnel
	return 'smoke'; // default (bare URL) + explicit ?ds=smoke
}

/** Drizzle table object per dataset (typed selects). */
export const DATASET_TABLE = {
	funnel: schema.routerTradesGated,
	smoke: schema.smokeTrades,
	smoke02: schema.smokeTrades,
	smoke03: schema.smokeTrades,
	smoke04: schema.smokeTrades,
	smoke05: schema.smokeTrades,
} as const;

/** Physical table name per dataset (raw-SQL aggregate). Whitelisted — never user input. */
export const DATASET_TABLE_NAME: Record<Dataset, string> = {
	funnel: 'router_trades_gated',
	smoke: 'smoke_trades',
	smoke02: 'smoke_trades',
	smoke03: 'smoke_trades',
	smoke04: 'smoke_trades',
	smoke05: 'smoke_trades',
};

/** Batch filter per dataset. Only smoke datasets filter by batch. */
export const DATASET_BATCH: Record<Dataset, string | undefined> = {
	funnel: undefined,
	smoke: 'smoke-01',
	smoke02: 'smoke-02',
	smoke03: 'smoke-03',
	smoke04: 'smoke-04',
	smoke05: 'smoke-05',
};
