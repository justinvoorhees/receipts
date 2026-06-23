import { schema } from '@fabric-tca/db';

export type Dataset = 'funnel' | 'smoke';
export const DEFAULT_DATASET: Dataset = 'funnel';

export function parseDataset(v: string | undefined): Dataset {
	return v === 'smoke' ? 'smoke' : 'funnel';
}

/** Drizzle table object per dataset (typed selects). */
export const DATASET_TABLE = {
	funnel: schema.routerTradesGated,
	smoke: schema.smokeTrades,
} as const;

/** Physical table name per dataset (raw-SQL aggregate). Whitelisted — never user input. */
export const DATASET_TABLE_NAME: Record<Dataset, string> = {
	funnel: 'router_trades_gated',
	smoke: 'smoke_trades',
};
