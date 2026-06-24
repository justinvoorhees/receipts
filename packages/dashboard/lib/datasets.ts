import { schema } from '@fabric-tca/db';

export type Dataset = 'funnel' | 'smoke' | 'smoke02';
export const DEFAULT_DATASET: Dataset = 'funnel';

export function parseDataset(v: string | undefined): Dataset {
	if (v === 'smoke') return 'smoke';
	if (v === 'smoke02') return 'smoke02';
	return 'funnel';
}

/** Drizzle table object per dataset (typed selects). */
export const DATASET_TABLE = {
	funnel: schema.routerTradesGated,
	smoke: schema.smokeTrades,
	smoke02: schema.smokeTrades,
} as const;

/** Physical table name per dataset (raw-SQL aggregate). Whitelisted — never user input. */
export const DATASET_TABLE_NAME: Record<Dataset, string> = {
	funnel: 'router_trades_gated',
	smoke: 'smoke_trades',
	smoke02: 'smoke_trades',
};

/** Batch filter per dataset. Only smoke datasets filter by batch. */
export const DATASET_BATCH: Record<Dataset, string | undefined> = {
	funnel: undefined,
	smoke: 'smoke-01',
	smoke02: 'smoke-02',
};
