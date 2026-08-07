import type { FeeSinkNamed } from '@fabric-tca/core';
import type { Receipt } from '@fabric-tca/core/pure';
import type { RouteLeg } from './legRouterEnrichment';

/**
 * The one receipt shape the UI consumes.
 *
 * This is core's `Receipt` plus the two read-time enrichments applied in
 * loadReceipt: fee sinks gain a resolved `name`, legs gain a resolved `router`.
 *
 * It replaces `ReceiptRow`, which was a lossy projection of this same type —
 * the same fields, with `numeric` columns arriving as strings because Drizzle
 * returns them that way, plus id/createdAt/userId bookkeeping. With no database
 * there is no reason for numbers to travel as strings.
 */
export type ReceiptModel = Omit<Receipt, 'feeSinks' | 'routeLegs'> & {
	feeSinks: FeeSinkNamed[];
	routeLegs: RouteLeg[] | null;
};
